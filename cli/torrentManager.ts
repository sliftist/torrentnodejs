import { EventEmitter } from "events";
import crypto from "crypto";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import { Transport } from "../transport";
import { Torrent, RunMode } from "../torrent";
import { TorrentMeta, parseTorrentFile, pieceLengthAt } from "../torrentFile";
import { PeerListener } from "../peerListener";
import { RateLimiter } from "../rateLimiter";
import { ChokeManager } from "../chokeManager";
import { ConnectionBudget } from "../connectionBudget";
import { DialStats } from "../dialStats";
import { yieldIfBlocked } from "../cooperativeYield";
import { SchedulerSettings } from "./config";

const STATE_FILENAME = "bittorrent.state.json";
const RATE_ALPHA = 0.35; // EMA smoothing for rates
// Cap on torrents whose initial disk-verify is in flight at once, so adding a
// big batch doesn't hammer the disk all at once.
const MAX_CONCURRENT_STARTS = 8;
// A complete torrent counts as "seeding actively" if it has uploaded within
// this window; otherwise it's idle (no one has downloaded recently).
const SEED_ACTIVE_WINDOW_MS = 60 * 1000;
// 1 megabit per second = 125000 bytes per second.
const BYTES_PER_MBIT = 125000;
const CHOKE_INTERVAL_MS = 10 * 1000;

export type TorrentState =
    | "queued"
    | "checking"
    | "checked"      // scan-mode: drive verified, incomplete
    | "ready"        // scrape-mode: swarm stats gathered, no transfers
    | "downloading"  // holds a download slot, fetching blocks
    | "seeding"      // complete, uploaded recently
    | "idle"         // complete, no recent uploads
    | "done"         // scan-mode: complete
    | "paused"
    | "error";

export interface TorrentView {
    infoHash: string;
    name: string;
    state: TorrentState;
    progress: number;
    sizeBytes: number;
    downloadedBytes: number;
    uploadedBytes: number;
    downRate: number;
    upRate: number;
    peerCount: number;
    connectedPeers: number;
    seeders: number;
    swarmPeers: number;
    peersUnchokingUs: number;
    peersWeUnchoked: number;
    etaSeconds: number;       // Infinity when unknown
    ratio: number;
    trackersResponding: number;
    trackersTotal: number;
    error?: string;
    sourcePath: string;
    creationDate: number;
}

// The four lists from the spec.
export type SectionKey = "downloading" | "seeding" | "downloadingQueued" | "downloadingNoPeers" | "seedingIdle";

export const SECTION_TITLES: Record<SectionKey, string> = {
    downloading: "downloading actively",
    seeding: "seeding actively",
    downloadingQueued: "downloading but queued (no free slot)",
    downloadingNoPeers: "downloading but no seeders",
    seedingIdle: "seeding, but no one has downloaded for the last minute",
};

export const SECTION_ORDER: SectionKey[] = ["downloading", "seeding", "downloadingQueued", "downloadingNoPeers", "seedingIdle"];

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
    connections: number;
    downRate: number;
    upRate: number;
    downloadedBytes: number;
    uploadedBytes: number;
    // True wire-level tunnel traffic (encrypted bytes/packets incl. overhead),
    // with bytes/sec smoothed over a trailing window. Zero when the transport
    // can't measure it.
    wireBytesSent: number;
    wireBytesReceived: number;
    wirePacketsSent: number;
    wirePacketsReceived: number;
    wireSendRate: number;
    wireRecvRate: number;
    // Outbound peer dials: cumulative totals plus the average per-second rate
    // over the trailing 60 seconds. "failed" dials never reached a working peer.
    dialAttempts: number;
    dialFailures: number;
    dialAttemptRate: number;
    dialFailRate: number;
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
    started: boolean;
    starting: boolean;
    knownProgress: number;
    paused: boolean;
    error?: string;
    // Holds a download slot (actively requesting blocks).
    downloadEnabled: boolean;
    // Rolling-queue position; lower = closer to the front. New torrents get a
    // decreasing value (front); evicted torrents go to the back.
    queueOrder: number;
    // Skip-limit bookkeeping.
    lastProgressBytes: number;
    lastProgressAtMs: number;
    // Seed-activity bookkeeping.
    lastUploadAtMs: number;
    lastUploadBytes: number;
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
    listenPort: number;
    stateDir?: string;
    peerId?: Buffer;
    mode?: RunMode;
}

// Owns every torrent's lifecycle. Per the spec: ALL torrents are announced and
// connect to peers; a global download-slot budget decides which incomplete ones
// actively request blocks (rolling queue, evicting stalled ones); and global
// connection/rate/upload-slot limits are enforced through shared services.
export class TorrentManager extends EventEmitter {
    private readonly transport: Transport;
    private readonly downloadDir: string;
    private readonly scheduler: SchedulerSettings;
    private readonly peerId: Buffer;
    private readonly stateDir: string;
    private readonly listenPort: number;
    private mode: RunMode;
    private readonly torrents = new Map<string, ManagedTorrent>();
    private readonly bySource = new Map<string, string>();
    private pausedPersisted = new Set<string>();
    // Torrents the web client asked to prioritize: each is guaranteed a download
    // slot and (collectively) up to half the download bandwidth.
    private readonly prioritized = new Set<string>();
    // Torrents with an in-flight web block request: infoHash -> pending count.
    // While pending they're guaranteed a slot (but don't get the bandwidth split).
    private readonly forcedSlots = new Map<string, number>();
    private ticker?: NodeJS.Timeout;
    private lastTickMs = Date.now();
    private stopped = false;
    private frontSeq = 0;
    private backSeq = 0;
    // Wire-level traffic rate sampling (EMA over the trailing window).
    private lastWireSent = 0;
    private lastWireReceived = 0;
    private wireSendRate = 0;
    private wireRecvRate = 0;
    // Trailing 60-second samples of cumulative dial counters, for the per-second
    // rate. One sample per tick (~1s); entries older than 60s are dropped.
    private dialSamples: { t: number; attempts: number; failures: number }[] = [];
    private dialAttemptRate = 0;
    private dialFailRate = 0;

    // Shared services, created on start().
    private peerListener?: PeerListener;
    private downloadLimiter?: RateLimiter;
    // Dedicated bucket for prioritized torrents: half the global download rate.
    private priorityDownloadLimiter?: RateLimiter;
    private uploadLimiter?: RateLimiter;
    private chokeManager?: ChokeManager;
    private connectionBudget?: ConnectionBudget;
    private dialStats?: DialStats;

    constructor(opts: TorrentManagerOptions) {
        super();
        this.transport = opts.transport;
        this.downloadDir = opts.downloadDir;
        this.scheduler = opts.scheduler;
        this.peerId = opts.peerId ?? Buffer.concat([Buffer.from("-CK0001-"), crypto.randomBytes(12)]);
        this.stateDir = opts.stateDir ?? process.cwd();
        this.listenPort = opts.listenPort;
        this.mode = opts.mode ?? "full";
    }

    get runMode(): RunMode { return this.mode; }

    setMode(mode: RunMode): void {
        if (mode === this.mode) return;
        this.mode = mode;
        this.emit("notice", `Mode → ${mode}`);
        this.emit("update");
        // Tearing down every torrent at once fires a synchronous burst of TCP
        // RST sends (each a JS encrypt + native dgram send) with no IO awaits to
        // break it up, freezing input/rendering — badly on Windows. Release them
        // one at a time, yielding when we've blocked too long.
        void this.tearDownAll();
    }

    private async tearDownAll(): Promise<void> {
        for (const m of [...this.torrents.values()]) {
            await this.releaseTorrent(m);
            await yieldIfBlocked();
        }
    }

    async start(): Promise<void> {
        await this.loadState();
        this.peerListener = new PeerListener(this.transport);
        // A failed bind shouldn't take the whole client down; we just won't
        // accept inbound peers (outbound still works).
        await this.peerListener.start(this.listenPort).catch((e) => {
            this.emit("notice", `Listener bind failed: ${(e as Error).message}`);
            this.peerListener = undefined;
        });
        this.downloadLimiter = new RateLimiter(this.scheduler.downloadMbps * BYTES_PER_MBIT);
        this.priorityDownloadLimiter = new RateLimiter((this.scheduler.downloadMbps * BYTES_PER_MBIT) / 2);
        this.uploadLimiter = new RateLimiter(this.scheduler.uploadMbps * BYTES_PER_MBIT);
        this.connectionBudget = new ConnectionBudget(this.scheduler.activeConnections);
        this.dialStats = new DialStats();
        this.chokeManager = new ChokeManager({
            uploadSlots: this.scheduler.uploadSlots,
            optimisticSlots: this.scheduler.optimisticUnchokeSlots,
            intervalMs: CHOKE_INTERVAL_MS,
        });
        this.chokeManager.start();

        this.lastTickMs = Date.now();
        this.ticker = setInterval(() => this.tick().catch((e) => this.emit("error", e)), 1000);
        this.ticker.unref?.();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.ticker) clearInterval(this.ticker);
        this.chokeManager?.stop();
        this.peerListener?.close();
        await Promise.allSettled([...this.torrents.values()].map((m) => m.torrent?.stop()));
        await this.saveState();
    }

    // ---- source folder watcher integration ----

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
        if (this.torrents.has(infoHash)) return;
        const now = Date.now();
        this.torrents.set(infoHash, {
            infoHash,
            name: meta.name,
            sourcePath,
            meta,
            started: false,
            starting: false,
            knownProgress: 0,
            paused: this.pausedPersisted.has(infoHash),
            downloadEnabled: false,
            // Newly added torrents go to the front of the rolling queue.
            queueOrder: --this.frontSeq,
            lastProgressBytes: 0,
            lastProgressAtMs: now,
            lastUploadAtMs: 0,
            lastUploadBytes: 0,
            lastDown: 0,
            lastUp: 0,
            downRate: 0,
            upRate: 0,
        });
        this.emit("update");
    }

    async removeSourceFile(sourcePath: string): Promise<void> {
        const infoHash = this.bySource.get(sourcePath);
        if (!infoHash) return;
        this.bySource.delete(sourcePath);
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
            await this.releaseTorrent(m);
        } else {
            this.pausedPersisted.delete(infoHash);
            // Unpaused torrents jump to the front of the queue.
            m.queueOrder = --this.frontSeq;
        }
        await this.saveState();
        this.emit("update");
    }

    // ---- web-control prioritization ----

    // Mark a torrent as prioritized (or clear it): it's guaranteed a download
    // slot and shares (with any other prioritized torrents) up to half the
    // global download bandwidth.
    setPriority(infoHash: string, on: boolean): void {
        const m = this.torrents.get(infoHash);
        if (!m) throw new Error(`Unknown torrent ${infoHash}`);
        if (on) {
            this.prioritized.add(infoHash);
            // Jump to the front so it also wins the regular queue ordering.
            m.queueOrder = --this.frontSeq;
        } else {
            this.prioritized.delete(infoHash);
        }
        this.applyBandwidthSplit();
        this.applyLimiter(m);
        this.runScheduler(Date.now());
        this.emit("update");
    }

    // Fetch one specific block, prioritizing its piece. Resolves once the piece
    // has downloaded and verified; may take a while on a slow torrent.
    async requestBlock(config: { infoHash: string; pieceIndex: number; begin: number; length: number }): Promise<Buffer> {
        const { infoHash, pieceIndex, begin, length } = config;
        const m = this.torrents.get(infoHash);
        if (!m) throw new Error(`Unknown torrent ${infoHash}`);
        const numPieces = m.meta.pieceHashes.length;
        if (pieceIndex < 0 || pieceIndex >= numPieces) {
            throw new Error(`pieceIndex out of range: ${pieceIndex}, expected 0..${numPieces - 1}`);
        }
        const pieceLen = pieceLengthAt(m.meta, pieceIndex);
        if (begin < 0 || length <= 0 || begin + length > pieceLen) {
            throw new Error(`block [${begin}, ${begin + length}) out of bounds for piece ${pieceIndex} of length ${pieceLen}`);
        }

        this.forcedSlots.set(infoHash, (this.forcedSlots.get(infoHash) || 0) + 1);
        try {
            const t = await this.ensureStartedTorrent(m);
            if (!t.pieceManager.selected.has(pieceIndex)) {
                throw new Error(`piece ${pieceIndex} is not in this torrent's selection`);
            }
            t.pieceManager.prioritizePiece(pieceIndex);
            this.runScheduler(Date.now());
            t.kickRequests();
            if (!t.pieceManager.haveBitfield.get(pieceIndex)) {
                await this.waitForPiece(t, pieceIndex);
            }
            return await t.storage.readBlock(pieceIndex, begin, length);
        } finally {
            const remaining = (this.forcedSlots.get(infoHash) || 1) - 1;
            if (remaining <= 0) this.forcedSlots.delete(infoHash);
            else this.forcedSlots.set(infoHash, remaining);
            this.runScheduler(Date.now());
        }
    }

    isPrioritized(infoHash: string): boolean {
        return this.prioritized.has(infoHash);
    }

    private mustHaveSlot(m: ManagedTorrent): boolean {
        return this.prioritized.has(m.infoHash) || this.forcedSlots.has(m.infoHash);
    }

    private applyBandwidthSplit(): void {
        if (!this.downloadLimiter) return;
        const full = this.scheduler.downloadMbps * BYTES_PER_MBIT;
        let sharedRate = full;
        if (this.prioritized.size > 0) sharedRate = full / 2;
        this.downloadLimiter.setRate(sharedRate);
        this.priorityDownloadLimiter?.setRate(full / 2);
    }

    private applyLimiter(m: ManagedTorrent): void {
        if (!m.torrent) return;
        let limiter = this.downloadLimiter;
        if (this.prioritized.has(m.infoHash)) limiter = this.priorityDownloadLimiter;
        m.torrent.setDownloadLimiter(limiter);
    }

    private async ensureStartedTorrent(m: ManagedTorrent): Promise<Torrent> {
        this.runScheduler(Date.now());
        await this.waitForCondition(() => {
            if (m.error) throw new Error(`Torrent ${m.infoHash} failed: ${m.error}`);
            return Boolean(m.torrent && m.started);
        });
        const t = m.torrent;
        if (!t) throw new Error(`Torrent ${m.infoHash} failed to start`);
        return t;
    }

    // Resolves when `predicate` becomes true, re-checking on every manager
    // "update" (~1/s plus on events). Rejects if the predicate throws.
    private waitForCondition(predicate: () => boolean): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const check = () => {
                let done = false;
                try {
                    done = predicate();
                } catch (e) {
                    this.off("update", check);
                    reject(e as Error);
                    return;
                }
                if (done) {
                    this.off("update", check);
                    resolve();
                }
            };
            this.on("update", check);
            check();
        });
    }

    private waitForPiece(t: Torrent, pieceIndex: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const onPiece = (i: number) => {
                if (i !== pieceIndex) return;
                cleanup();
                resolve();
            };
            const onError = (e: Error) => {
                cleanup();
                reject(e);
            };
            const cleanup = () => {
                t.off("piece", onPiece);
                t.off("error", onError);
            };
            t.on("piece", onPiece);
            t.on("error", onError);
            if (t.pieceManager.haveBitfield.get(pieceIndex)) {
                cleanup();
                resolve();
            }
        });
    }

    // ---- snapshots for the TUI ----

    aggregate(): AggregateView {
        let downloading = 0, seeding = 0, paused = 0, downRate = 0, upRate = 0, dl = 0, ul = 0;
        for (const m of this.torrents.values()) {
            const complete = this.isComplete(m);
            if (m.paused) paused++;
            else if (complete && m.torrent) seeding++;
            else if (m.downloadEnabled) downloading++;
            downRate += m.downRate;
            upRate += m.upRate;
            dl += m.torrent?.downloadedBytes ?? 0;
            ul += m.torrent?.uploadedBytes ?? 0;
        }
        const wire = this.transport.trafficStats?.();
        return {
            torrents: this.torrents.size,
            downloading, seeding, paused,
            connections: this.connectionBudget?.count ?? 0,
            downRate, upRate,
            downloadedBytes: dl, uploadedBytes: ul,
            wireBytesSent: wire?.bytesSent ?? 0,
            wireBytesReceived: wire?.bytesReceived ?? 0,
            wirePacketsSent: wire?.packetsSent ?? 0,
            wirePacketsReceived: wire?.packetsReceived ?? 0,
            wireSendRate: this.wireSendRate,
            wireRecvRate: this.wireRecvRate,
            dialAttempts: this.dialStats?.attempts ?? 0,
            dialFailures: this.dialStats?.failures ?? 0,
            dialAttemptRate: this.dialAttemptRate,
            dialFailRate: this.dialFailRate,
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

    sections(): TorrentSection[] {
        const buckets: Record<SectionKey, ManagedTorrent[]> = {
            downloading: [], seeding: [], downloadingQueued: [], downloadingNoPeers: [], seedingIdle: [],
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

    // ---- internals ----

    private sectionOf(m: ManagedTorrent): SectionKey {
        const complete = this.isComplete(m);
        if (complete) {
            if (m.torrent && this.uploadedRecently(m)) return "seeding";
            return "seedingIdle";
        }
        if (m.torrent && m.downloadEnabled) return "downloading";
        // Incomplete and not in a download slot: split "has peers but is waiting
        // for a free slot" from "actively trying but nobody is seeding to us".
        // Paused/checking/not-yet-started torrents fall through to the queued
        // bucket rather than being mislabelled as having no seeders.
        if (m.torrent && m.started && !m.paused && m.torrent.connectedPeers === 0) return "downloadingNoPeers";
        return "downloadingQueued";
    }

    private uploadedRecently(m: ManagedTorrent): boolean {
        return Date.now() - m.lastUploadAtMs < SEED_ACTIVE_WINDOW_MS;
    }

    private isComplete(m: ManagedTorrent): boolean {
        if (m.meta.totalLength === 0) return true;
        const p = m.torrent ? m.torrent.progress : m.knownProgress;
        return p >= 1;
    }

    private toView(m: ManagedTorrent): TorrentView {
        const t = m.torrent;
        const size = m.meta.totalLength;
        const downloaded = t?.downloadedBytes ?? 0;
        const uploaded = t?.uploadedBytes ?? 0;
        let progress = m.knownProgress;
        if (t) progress = t.progress;
        else if (size === 0) progress = 1;
        let etaSeconds = Infinity;
        const remaining = size - downloaded;
        if (remaining <= 0) etaSeconds = 0;
        else if (m.downRate > 0) etaSeconds = remaining / m.downRate;
        let ratio = 0;
        if (downloaded > 0) ratio = uploaded / downloaded;
        return {
            infoHash: m.infoHash,
            name: m.name,
            state: this.displayState(m),
            progress,
            sizeBytes: size,
            downloadedBytes: downloaded,
            uploadedBytes: uploaded,
            downRate: m.downRate,
            upRate: m.upRate,
            peerCount: t?.peers.length ?? 0,
            connectedPeers: t?.connectedPeers ?? 0,
            seeders: t?.swarmSeeders ?? 0,
            swarmPeers: t?.swarmPeers ?? 0,
            peersUnchokingUs: t?.peersUnchokingUs ?? 0,
            peersWeUnchoked: t?.peersWeUnchoked ?? 0,
            etaSeconds,
            ratio,
            trackersResponding: t?.trackersResponding ?? 0,
            trackersTotal: t?.trackersTotal ?? m.meta.announceList.flat().length,
            error: m.error,
            sourcePath: m.sourcePath,
            creationDate: m.meta.creationDate ?? 0,
        };
    }

    private displayState(m: ManagedTorrent): TorrentState {
        if (m.error) return "error";
        if (m.paused) return "paused";
        if (!m.torrent) return "queued";
        if (!m.started) return "checking";
        const complete = this.isComplete(m);
        if (this.mode === "scan") {
            if (complete) return "done";
            return "checked";
        }
        if (this.mode === "scrape") return "ready";
        if (complete) {
            if (this.uploadedRecently(m)) return "seeding";
            return "idle";
        }
        if (m.downloadEnabled) return "downloading";
        return "queued";
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        const now = Date.now();
        const dt = Math.max(0.001, (now - this.lastTickMs) / 1000);
        this.lastTickMs = now;

        for (const m of this.torrents.values()) {
            const t = m.torrent;
            if (!t) {
                m.downRate *= 1 - RATE_ALPHA;
                m.upRate *= 1 - RATE_ALPHA;
                continue;
            }
            const down = t.downloadedBytes;
            const up = t.uploadedBytes;
            const dInst = Math.max(0, down - m.lastDown) / dt;
            const uInst = Math.max(0, up - m.lastUp) / dt;
            m.downRate = RATE_ALPHA * dInst + (1 - RATE_ALPHA) * m.downRate;
            m.upRate = RATE_ALPHA * uInst + (1 - RATE_ALPHA) * m.upRate;
            m.lastDown = down;
            m.lastUp = up;
            m.knownProgress = t.progress;
            // Skip-limit: note the last time we actually fetched new data.
            if (down > m.lastProgressBytes) {
                m.lastProgressBytes = down;
                m.lastProgressAtMs = now;
            }
            // Seed-activity: note the last time we uploaded anything.
            if (up > m.lastUploadBytes) {
                m.lastUploadBytes = up;
                m.lastUploadAtMs = now;
            }
        }

        const wire = this.transport.trafficStats?.();
        if (wire) {
            const sInst = Math.max(0, wire.bytesSent - this.lastWireSent) / dt;
            const rInst = Math.max(0, wire.bytesReceived - this.lastWireReceived) / dt;
            this.wireSendRate = RATE_ALPHA * sInst + (1 - RATE_ALPHA) * this.wireSendRate;
            this.wireRecvRate = RATE_ALPHA * rInst + (1 - RATE_ALPHA) * this.wireRecvRate;
            this.lastWireSent = wire.bytesSent;
            this.lastWireReceived = wire.bytesReceived;
        }

        if (this.dialStats) {
            this.dialSamples.push({ t: now, attempts: this.dialStats.attempts, failures: this.dialStats.failures });
            while (this.dialSamples.length > 0 && now - this.dialSamples[0].t > 60_000) this.dialSamples.shift();
            const oldest = this.dialSamples[0];
            const span = (now - oldest.t) / 1000;
            if (span > 0) {
                this.dialAttemptRate = (this.dialStats.attempts - oldest.attempts) / span;
                this.dialFailRate = (this.dialStats.failures - oldest.failures) / span;
            }
        }

        this.runScheduler(now);
        this.emit("update");
    }

    private runScheduler(now: number): void {
        const torrents = [...this.torrents.values()];
        this.ensureStarted(torrents);

        // Download slots only apply in full mode (scan/scrape never transfer).
        if (this.mode !== "full") return;

        // Release slots held by torrents that can no longer use one.
        for (const m of torrents) {
            if (m.downloadEnabled && !this.eligibleForSlot(m)) this.setSlot(m, false, now);
        }

        // Prioritized / block-request torrents always get a slot, even past the
        // global cap; they're never evicted below.
        for (const m of torrents) {
            if (this.mustHaveSlot(m) && this.eligibleForSlot(m) && !m.downloadEnabled) this.setSlot(m, true, now);
        }

        let waiters = torrents
            .filter((m) => this.eligibleForSlot(m) && !m.downloadEnabled && !this.mustHaveSlot(m))
            .sort((a, b) => a.queueOrder - b.queueOrder);

        // Evict stalled holders only when something is waiting to take the slot.
        if (waiters.length > 0) {
            for (const h of torrents) {
                if (!h.downloadEnabled || this.mustHaveSlot(h)) continue;
                if (now - h.lastProgressAtMs > this.scheduler.downloadSkipLimitMs) {
                    this.setSlot(h, false, now);
                    h.queueOrder = ++this.backSeq;
                }
            }
            waiters = torrents
                .filter((m) => this.eligibleForSlot(m) && !m.downloadEnabled && !this.mustHaveSlot(m))
                .sort((a, b) => a.queueOrder - b.queueOrder);
        }

        let active = torrents.filter((m) => m.downloadEnabled).length;
        for (const w of waiters) {
            if (active >= this.scheduler.downloadSlots) break;
            this.setSlot(w, true, now);
            active++;
        }
    }

    // A torrent can hold a download slot only if it's running, incomplete, not
    // paused, and actually has peers to download from (spec: no slot without peers).
    private eligibleForSlot(m: ManagedTorrent): boolean {
        if (m.paused || m.error || !m.torrent || !m.started) return false;
        if (this.isComplete(m)) return false;
        return m.torrent.connectedPeers > 0;
    }

    private setSlot(m: ManagedTorrent, enabled: boolean, now: number): void {
        if (m.downloadEnabled === enabled) return;
        m.downloadEnabled = enabled;
        m.torrent?.setDownloadEnabled(enabled);
        if (enabled) {
            m.lastProgressBytes = m.torrent?.downloadedBytes ?? 0;
            m.lastProgressAtMs = now;
        }
    }

    private ensureStarted(torrents: ManagedTorrent[]): void {
        let inFlight = torrents.filter((m) => m.starting).length;
        const toStart = torrents
            .filter((m) => {
                if (m.torrent || m.starting || m.paused || m.error) return false;
                // Scan mode checks each torrent once; don't restart finished scans.
                if (this.mode === "scan" && (m.started)) return false;
                return true;
            })
            .sort((a, b) => a.queueOrder - b.queueOrder);
        for (const m of toStart) {
            if (inFlight >= MAX_CONCURRENT_STARTS) break;
            this.startTorrent(m);
            inFlight++;
        }
    }

    private startTorrent(m: ManagedTorrent): void {
        m.starting = true;
        const t = new Torrent({
            meta: m.meta,
            transport: this.transport,
            peerId: this.peerId,
            options: {
                saveDir: this.downloadDir,
                maxPeers: this.scheduler.connectionsPerTorrent,
                verifyExisting: true,
                mode: this.mode,
                downloadEnabled: false,
                peerListener: this.peerListener,
                downloadLimiter: this.downloadLimiter,
                uploadLimiter: this.uploadLimiter,
                chokeManager: this.chokeManager,
                connectionBudget: this.connectionBudget,
                dialStats: this.dialStats,
                listenPort: this.listenPort,
            },
        });
        m.torrent = t;
        t.on("error", (e: Error) => {
            m.error = e.message;
            this.emit("update");
        });
        t.start()
            .then(() => {
                m.started = true;
                m.starting = false;
                m.knownProgress = t.progress;
                // A torrent prioritized before it started gets its half-rate
                // limiter now that the instance exists.
                this.applyLimiter(m);
                this.emit("update");
            })
            .catch((e: Error) => {
                m.error = e.message;
                m.torrent = undefined;
                m.started = false;
                m.starting = false;
                this.emit("update");
            });
    }

    private async releaseTorrent(m: ManagedTorrent): Promise<void> {
        if (m.torrent) m.knownProgress = m.torrent.progress;
        m.downloadEnabled = false;
        const t = m.torrent;
        m.torrent = undefined;
        m.started = false;
        m.starting = false;
        await t?.stop().catch(() => {});
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
