import { EventEmitter } from "events";
import crypto from "crypto";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import { Transport } from "../transport";
import { Torrent } from "../torrent";
import { TorrentMeta, parseTorrentFile } from "../torrentFile";
import { RunMode } from "../torrent";
import { SchedulerSettings } from "./config";

const STATE_FILENAME = "bittorrent.state.json";
const RATE_ALPHA = 0.35; // EMA smoothing for rates

export type TorrentState =
    | "queued"      // known, waiting for a scheduler slot
    | "checking"    // verifying on-disk pieces at startup
    | "checked"     // scan-mode: drive verified, nothing more to do
    | "ready"       // connect-mode: peers/availability known, no transfers
    | "downloading" // active, still missing pieces
    | "seeding"     // active, complete, serving to others
    | "paused"      // user-paused; never scheduled
    | "done"        // complete and not actively seeding (queued-seed)
    | "error";      // failed to start/parse

export interface TorrentView {
    infoHash: string;
    name: string;
    state: TorrentState;
    progress: number;       // 0..1
    sizeBytes: number;
    downloadedBytes: number;
    uploadedBytes: number;
    downRate: number;       // bytes/sec (EMA)
    upRate: number;         // bytes/sec (EMA)
    peerCount: number;
    error?: string;
    sourcePath: string;
}

export interface AggregateView {
    torrents: number;
    downloading: number;
    seeding: number;
    paused: number;
    downRate: number;
    upRate: number;
    downloadedBytes: number;
    uploadedBytes: number;
}

export interface TorrentDetail {
    infoHash: string;
    name: string;
    files: { path: string; length: number }[];
    peers: { ip: string; port: number; direction: "in" | "out"; peerChoking: boolean; amChoking: boolean; inflight: number }[];
    trackers: { url: string; status: string; seeders?: number; leechers?: number; peers?: number; error?: string }[];
    pieceStates: ("needed" | "downloading" | "done")[];
    pieceCounts: { needed: number; downloading: number; done: number };
}

interface ManagedTorrent {
    infoHash: string;
    name: string;
    sourcePath: string;
    meta: TorrentMeta;
    torrent?: Torrent;
    state: TorrentState;
    paused: boolean;
    error?: string;
    listenPort: number;
    // rate sampling
    lastDown: number;
    lastUp: number;
    downRate: number;
    upRate: number;
}

export interface TorrentManagerOptions {
    transport: Transport;
    downloadDir: string;
    scheduler: SchedulerSettings;
    listenPortBase: number;
    stateDir?: string;
    peerId?: Buffer;
    // Initial run mode. Defaults to "full". Changeable at runtime via setMode.
    mode?: RunMode;
}

// Owns the full lifecycle of every torrent: parsing, the qBittorrent-style
// active-count scheduler, per-torrent rate tracking, and pause-state
// persistence. Emits 'update' on every tick so the TUI can re-render from a
// fresh snapshot.
export class TorrentManager extends EventEmitter {
    private readonly transport: Transport;
    private readonly downloadDir: string;
    private readonly scheduler: SchedulerSettings;
    private readonly peerId: Buffer;
    private readonly stateDir: string;
    private mode: RunMode;
    private readonly torrents = new Map<string, ManagedTorrent>(); // by infoHash
    private readonly bySource = new Map<string, string>();          // sourcePath -> infoHash
    private pausedPersisted = new Set<string>();
    private nextListenPort: number;
    private ticker?: NodeJS.Timeout;
    private lastTickMs = Date.now();
    private stopped = false;

    constructor(opts: TorrentManagerOptions) {
        super();
        this.transport = opts.transport;
        this.downloadDir = opts.downloadDir;
        this.scheduler = opts.scheduler;
        this.peerId = opts.peerId ?? Buffer.concat([Buffer.from("-CK0001-"), crypto.randomBytes(12)]);
        this.stateDir = opts.stateDir ?? process.cwd();
        this.nextListenPort = opts.listenPortBase;
        this.mode = opts.mode ?? "full";
    }

    get runMode(): RunMode { return this.mode; }

    // Switch run mode at runtime. Running torrents are torn down and re-queued
    // so they restart under the new phase gating (e.g. connect→full begins
    // actually transferring; full→scan drops all peer connections).
    setMode(mode: RunMode): void {
        if (mode === this.mode) return;
        this.mode = mode;
        for (const m of this.torrents.values()) {
            if (!m.torrent) continue;
            void m.torrent.stop().catch(() => {});
            m.torrent = undefined;
            if (m.state !== "paused" && m.state !== "error") m.state = "queued";
        }
        this.emit("notice", `Mode → ${mode}`);
        this.emit("update");
    }

    async start(): Promise<void> {
        await this.loadState();
        this.lastTickMs = Date.now();
        this.ticker = setInterval(() => this.tick().catch((e) => this.emit("error", e)), 1000);
        this.ticker.unref?.();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.ticker) clearInterval(this.ticker);
        await Promise.allSettled([...this.torrents.values()].map((m) => m.torrent?.stop()));
        await this.saveState();
    }

    // ---- source folder watcher integration ----

    // Called when a .torrent file appears in a watched folder.
    async addSourceFile(sourcePath: string): Promise<void> {
        if (this.bySource.has(sourcePath)) return;
        let meta: TorrentMeta;
        try {
            meta = await parseTorrentFile(sourcePath);
        } catch (e) {
            this.emit("notice", `Failed to parse ${path.basename(sourcePath)}: ${(e as Error).message}`);
            return;
        }
        const infoHash = meta.infoHash.toString("hex");
        this.bySource.set(sourcePath, infoHash);
        const existing = this.torrents.get(infoHash);
        if (existing) return; // same torrent from another folder; keep first
        this.torrents.set(infoHash, {
            infoHash,
            name: meta.name,
            sourcePath,
            meta,
            state: this.pausedPersisted.has(infoHash) ? "paused" : "queued",
            paused: this.pausedPersisted.has(infoHash),
            listenPort: this.nextListenPort++,
            lastDown: 0,
            lastUp: 0,
            downRate: 0,
            upRate: 0,
        });
        this.emit("update");
    }

    // Called when a .torrent file disappears from every watched folder.
    async removeSourceFile(sourcePath: string): Promise<void> {
        const infoHash = this.bySource.get(sourcePath);
        if (!infoHash) return;
        this.bySource.delete(sourcePath);
        // Only drop the managed torrent if no other source still references it.
        for (const h of this.bySource.values()) if (h === infoHash) { this.emit("update"); return; }
        const m = this.torrents.get(infoHash);
        if (m) {
            await m.torrent?.stop().catch(() => {});
            this.torrents.delete(infoHash);
        }
        this.emit("update");
    }

    // ---- user controls ----

    async togglePause(infoHash: string): Promise<void> {
        const m = this.torrents.get(infoHash);
        if (!m) return;
        m.paused = !m.paused;
        if (m.paused) {
            this.pausedPersisted.add(infoHash);
            await m.torrent?.stop().catch(() => {});
            m.torrent = undefined;
            m.state = "paused";
        } else {
            this.pausedPersisted.delete(infoHash);
            m.state = "queued";
        }
        await this.saveState();
        this.emit("update");
    }

    // ---- snapshots for the TUI ----

    aggregate(): AggregateView {
        let downloading = 0, seeding = 0, paused = 0, downRate = 0, upRate = 0, dl = 0, ul = 0;
        for (const m of this.torrents.values()) {
            if (m.state === "downloading") downloading++;
            else if (m.state === "seeding") seeding++;
            else if (m.state === "paused") paused++;
            downRate += m.downRate;
            upRate += m.upRate;
            dl += m.torrent?.downloadedBytes ?? 0;
            ul += m.torrent?.uploadedBytes ?? 0;
        }
        return {
            torrents: this.torrents.size,
            downloading, seeding, paused,
            downRate, upRate,
            downloadedBytes: dl, uploadedBytes: ul,
        };
    }

    views(): TorrentView[] {
        return [...this.torrents.values()].map((m) => this.toView(m));
    }

    detail(infoHash: string): TorrentDetail | undefined {
        const m = this.torrents.get(infoHash);
        if (!m) return undefined;
        const t = m.torrent;
        return {
            infoHash: m.infoHash,
            name: m.name,
            files: m.meta.files.map((f) => ({ path: f.path.join("/"), length: f.length })),
            peers: t?.peerDetails ?? [],
            trackers: (t?.trackerStats ?? m.meta.announceList.flat().map((url) => ({ url, status: "pending" as const }))).map((s) => ({
                url: s.url,
                status: s.status,
                seeders: (s as { seeders?: number }).seeders,
                leechers: (s as { leechers?: number }).leechers,
                peers: (s as { peers?: number }).peers,
                error: (s as { error?: string }).error,
            })),
            pieceStates: t?.pieceStates ?? [],
            pieceCounts: t?.pieceCounts ?? { needed: 0, downloading: 0, done: m.meta.pieceHashes.length },
        };
    }

    // ---- internals ----

    private toView(m: ManagedTorrent): TorrentView {
        const t = m.torrent;
        const size = m.meta.totalLength;
        const downloaded = t?.downloadedBytes ?? 0;
        return {
            infoHash: m.infoHash,
            name: m.name,
            state: m.state,
            progress: t ? t.progress : (size === 0 ? 1 : downloaded / size),
            sizeBytes: size,
            downloadedBytes: downloaded,
            uploadedBytes: t?.uploadedBytes ?? 0,
            downRate: m.downRate,
            upRate: m.upRate,
            peerCount: t?.peers.length ?? 0,
            error: m.error,
            sourcePath: m.sourcePath,
        };
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        const now = Date.now();
        const dt = Math.max(0.001, (now - this.lastTickMs) / 1000);
        this.lastTickMs = now;

        // Rate sampling + state transitions for live torrents.
        for (const m of this.torrents.values()) {
            const t = m.torrent;
            if (t) {
                const down = t.downloadedBytes;
                const up = t.uploadedBytes;
                const dInst = Math.max(0, down - m.lastDown) / dt;
                const uInst = Math.max(0, up - m.lastUp) / dt;
                m.downRate = RATE_ALPHA * dInst + (1 - RATE_ALPHA) * m.downRate;
                m.upRate = RATE_ALPHA * uInst + (1 - RATE_ALPHA) * m.upRate;
                m.lastDown = down;
                m.lastUp = up;
                if (m.state !== "paused" && m.state !== "error") {
                    m.state = this.settledState(t);
                }
            } else {
                m.downRate *= 1 - RATE_ALPHA;
                m.upRate *= 1 - RATE_ALPHA;
            }
        }

        this.runScheduler();
        this.emit("update");
    }

    // The state a running torrent settles into once its check completes,
    // given the current run mode.
    private settledState(t: Torrent): TorrentState {
        if (this.mode === "scan") return t.progress >= 1 ? "done" : "checked";
        if (this.mode === "connect") return "ready";
        return t.progress >= 1 ? "seeding" : "downloading";
    }

    // qBittorrent-style active caps: count current actives, then fill spare
    // slots from the queue (FIFO by insertion order) respecting per-category
    // and total caps. Downloads are prioritized over seeds for the total cap.
    // Only "full" mode is slot-limited; scan/connect bring up every torrent
    // since they do bounded work and transfer no data.
    private runScheduler(): void {
        const all = [...this.torrents.values()];
        if (this.mode !== "full") {
            for (const m of all) {
                if (m.paused || m.torrent || m.state === "error") continue;
                this.startTorrent(m);
            }
            return;
        }
        const activeDownloads = all.filter((m) => m.torrent && m.state === "downloading").length;
        const activeSeeds = all.filter((m) => m.torrent && m.state === "seeding").length;
        let dlSlots = this.scheduler.maxActiveDownloads - activeDownloads;
        let seedSlots = this.scheduler.maxActiveSeeds - activeSeeds;
        let totalSlots = this.scheduler.maxActiveTotal - (activeDownloads + activeSeeds);

        for (const m of all) {
            if (totalSlots <= 0) break;
            if (m.paused || m.torrent) continue;
            if (m.state === "error") continue;
            // We don't yet know if it's complete until we start + verify, so
            // treat queued torrents as download candidates; a complete one will
            // immediately flip to seeding on its first tick.
            if (dlSlots <= 0) continue;
            this.startTorrent(m);
            dlSlots--;
            totalSlots--;
        }
        // seedSlots is reserved for future split scheduling; complete torrents
        // currently occupy download slots until they flip, which keeps the
        // total cap honest. Referenced to avoid an unused-variable error.
        void seedSlots;
    }

    private startTorrent(m: ManagedTorrent): void {
        m.state = "checking";
        const t = new Torrent({
            meta: m.meta,
            transport: this.transport,
            peerId: this.peerId,
            options: {
                saveDir: this.downloadDir,
                maxPeers: this.scheduler.maxPeersPerTorrent,
                listenPort: m.listenPort,
                verifyExisting: true,
                mode: this.mode,
            },
        });
        m.torrent = t;
        t.on("error", (e: Error) => {
            m.error = e.message;
            m.state = "error";
            this.emit("update");
        });
        t.start()
            .then(() => {
                if (m.state !== "paused" && m.state !== "error") m.state = this.settledState(t);
                this.emit("update");
            })
            .catch((e: Error) => {
                m.error = e.message;
                m.state = "error";
                m.torrent = undefined;
                this.emit("update");
            });
    }

    private statePath(): string {
        return path.join(this.stateDir, STATE_FILENAME);
    }

    private async loadState(): Promise<void> {
        try {
            const raw = await readFile(this.statePath(), "utf8");
            const parsed = JSON.parse(raw) as { paused?: string[] };
            this.pausedPersisted = new Set(parsed.paused || []);
        } catch {
            this.pausedPersisted = new Set();
        }
    }

    private async saveState(): Promise<void> {
        const body = JSON.stringify({ paused: [...this.pausedPersisted] }, null, 2);
        await writeFile(this.statePath(), body, "utf8").catch(() => {});
    }
}
