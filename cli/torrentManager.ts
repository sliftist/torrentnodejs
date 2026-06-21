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
    creationDate: number;   // unix seconds (0 if the .torrent had none)
}

// The four scheduler buckets the list view is grouped into. A torrent is
// "active" when it currently holds a slot; "complete" splits download vs seed.
export type SectionKey = "downloading" | "willDownload" | "seeding" | "willSeed";

export const SECTION_TITLES: Record<SectionKey, string> = {
    downloading: "actively downloading",
    willDownload: "will download (when we have a free download slot)",
    seeding: "seeding",
    willSeed: "will seed (when we have a free seed slot)",
};

export const SECTION_ORDER: SectionKey[] = ["downloading", "willDownload", "seeding", "willSeed"];

export interface TorrentSection {
    key: SectionKey;
    title: string;
    items: TorrentView[];
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
    // True once torrent.start() has resolved (initial check finished).
    started: boolean;
    // Last observed progress (0..1). Persists after the torrent is stopped so
    // the scheduler still knows whether it's complete.
    knownProgress: number;
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
            m.started = false;
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
            started: false,
            knownProgress: 0,
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
            m.started = false;
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
        let progress = m.knownProgress;
        if (t) progress = t.progress;
        else if (size === 0) progress = 1;
        return {
            infoHash: m.infoHash,
            name: m.name,
            state: m.state,
            progress,
            sizeBytes: size,
            downloadedBytes: downloaded,
            uploadedBytes: t?.uploadedBytes ?? 0,
            downRate: m.downRate,
            upRate: m.upRate,
            peerCount: t?.peers.length ?? 0,
            error: m.error,
            sourcePath: m.sourcePath,
            creationDate: m.meta.creationDate ?? 0,
        };
    }

    // Group every torrent into the four scheduler buckets and sort each by
    // .torrent creation date, newest first. The list view renders these.
    sections(): TorrentSection[] {
        const buckets: Record<SectionKey, ManagedTorrent[]> = {
            downloading: [], willDownload: [], seeding: [], willSeed: [],
        };
        for (const m of this.torrents.values()) buckets[this.sectionOf(m)].push(m);
        return SECTION_ORDER.map((key) => ({
            key,
            title: SECTION_TITLES[key],
            items: buckets[key]
                .sort((a, b) => (b.meta.creationDate ?? 0) - (a.meta.creationDate ?? 0))
                .map((m) => this.toView(m)),
        }));
    }

    private sectionOf(m: ManagedTorrent): SectionKey {
        const active = !!m.torrent;
        const complete = this.isComplete(m);
        if (complete) {
            if (active) return "seeding";
            return "willSeed";
        }
        if (active) return "downloading";
        return "willDownload";
    }

    private isComplete(m: ManagedTorrent): boolean {
        if (m.meta.totalLength === 0) return true;
        const p = m.torrent ? m.torrent.progress : m.knownProgress;
        return p >= 1;
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
                m.knownProgress = t.progress;
                // Leave the "checking" label in place until the initial check
                // resolves; only then does the torrent settle into a steady state.
                if (m.started && m.state !== "paused" && m.state !== "error") {
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

    // Slot scheduler. A torrent holds a download slot while incomplete (being
    // checked or downloading) and a seed slot once complete. Slots cap how many
    // torrents run at once in every mode, which also bounds open file handles.
    // Scan mode does one-shot work, so a torrent releases its slot the moment
    // its initial check finishes — letting the next queued torrent be checked.
    private runScheduler(): void {
        const all = [...this.torrents.values()];

        if (this.mode === "scan") {
            for (const m of all) {
                if (m.torrent && m.started) this.releaseTorrent(m);
            }
        }

        // A completed download may push the seed bucket over its cap, or a mode
        // switch may leave too many running; evict the oldest beyond each cap.
        this.evictOverCap(all, false);
        this.evictOverCap(all, true);

        // Fill free slots from the queue, newest .torrent first. Scan mode only
        // checks each torrent once, so already-scanned ones aren't restarted.
        const startable = all
            .filter((m) => {
                if (m.paused || m.torrent || m.state === "error") return false;
                if (this.mode === "scan" && (m.state === "checked" || m.state === "done")) return false;
                return true;
            })
            .sort((a, b) => (b.meta.creationDate ?? 0) - (a.meta.creationDate ?? 0));
        for (const m of startable) {
            const wantSeed = this.isComplete(m);
            if (this.freeSlots(all, wantSeed) <= 0) continue;
            this.startTorrent(m);
        }
    }

    // Count torrents currently occupying the given slot type. Complete running
    // torrents use seed slots; incomplete running torrents use download slots.
    private runningInSlot(all: ManagedTorrent[], seed: boolean): ManagedTorrent[] {
        return all.filter((m) => m.torrent && this.isComplete(m) === seed);
    }

    private freeSlots(all: ManagedTorrent[], seed: boolean): number {
        const cap = seed ? this.scheduler.seedSlots : this.scheduler.downloadSlots;
        return cap - this.runningInSlot(all, seed).length;
    }

    // Stop the oldest running torrents that exceed a slot cap, returning them to
    // the queue ("will download" / "will seed").
    private evictOverCap(all: ManagedTorrent[], seed: boolean): void {
        const cap = seed ? this.scheduler.seedSlots : this.scheduler.downloadSlots;
        const running = this.runningInSlot(all, seed)
            .sort((a, b) => (b.meta.creationDate ?? 0) - (a.meta.creationDate ?? 0));
        for (const m of running.slice(cap)) this.releaseTorrent(m);
    }

    // Tear down a running torrent but remember its progress so it can be
    // re-queued under the right slot type.
    private releaseTorrent(m: ManagedTorrent): void {
        if (m.torrent) m.knownProgress = m.torrent.progress;
        void m.torrent?.stop().catch(() => {});
        m.torrent = undefined;
        m.started = false;
        if (m.paused || m.state === "error") return;
        m.state = this.idleState(m);
    }

    // The label a torrent shows while it sits in the queue without a slot.
    private idleState(m: ManagedTorrent): TorrentState {
        if (this.mode === "scan") {
            if (this.isComplete(m)) return "done";
            return "checked";
        }
        if (this.mode === "connect") return "ready";
        if (this.isComplete(m)) return "done";
        return "queued";
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
                m.started = true;
                m.knownProgress = t.progress;
                if (m.state !== "paused" && m.state !== "error") m.state = this.settledState(t);
                this.emit("update");
            })
            .catch((e: Error) => {
                m.error = e.message;
                m.state = "error";
                m.torrent = undefined;
                m.started = false;
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
