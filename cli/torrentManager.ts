import { EventEmitter } from "events";
import crypto from "crypto";
import path from "path";
import { readFile, writeFile, stat, rm, rmdir } from "fs/promises";
import { Transport } from "../transport";
import { Torrent, RunMode } from "../torrent";
import { TorrentMeta, parseTorrentFile, pieceLengthAt } from "../torrentFile";
import { PeerListener } from "../peerListener";
import { RateLimiter } from "../rateLimiter";
import { ChokeManager } from "../chokeManager";
import { ConnectionBudget } from "../connectionBudget";
import { DialStats } from "../dialStats";
import { diskIO } from "../storage";
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
// While streaming a file over HTTP, prioritize this many bytes ahead of the
// piece currently being read out. Big enough to keep every peer busy on the
// stream's upcoming pieces (in order) rather than fanning out to scattered
// rarest-first pieces, which would stall in-order playback.
const STREAM_READAHEAD_BYTES = 32 * 1024 * 1024;

export type TorrentState =
    | "queued"
    | "unverified"   // on-disk data not hashed yet; waiting its turn to be scanned
    | "verifyOut"    // actively hashing the finished output files right now
    | "verifyTmp"    // actively hashing the in-progress temp copies right now
    | "checked"      // scan-mode: drive verified, incomplete
    | "corrupted"    // output files on disk don't fully match; partial/wrong data present
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
    pieceCount: number;
    // Estimated start: filesystem creation/modified time of the source .torrent.
    // Estimated finish: latest modified time across the output files. 0 = unknown.
    startedAtMs: number;
    finishedAtMs: number;
    // True when the torrent is currently prioritized (manually or because a file
    // of it is being streamed over HTTP). `rangeOutstanding`/`rangeFinished`
    // count whole HTTP Range requests the browser made (streaming now vs. done).
    // `rangeChunksRequested`/`rangeChunksReturned` count the individual chunks
    // those range requests span vs. have been written back, so the UI can tell
    // whether a stream is blocked or making progress.
    prioritized: boolean;
    rangeOutstanding: number;
    rangeFinished: number;
    rangeChunksRequested: number;
    rangeChunksReturned: number;
}

// The four lists from the spec.
export type SectionKey = "verifying" | "downloading" | "seeding" | "downloadingQueued" | "downloadingNoPeers" | "seedingIdle";

export const SECTION_TITLES: Record<SectionKey, string> = {
    verifying: "verifying (hashing on-disk data)",
    downloading: "downloading actively",
    seeding: "seeding actively",
    downloadingQueued: "downloading but queued (no free slot)",
    downloadingNoPeers: "downloading but no seeders",
    seedingIdle: "seeding, but no one has downloaded for the last minute",
};

export const SECTION_ORDER: SectionKey[] = ["verifying", "downloading", "seeding", "downloadingQueued", "downloadingNoPeers", "seedingIdle"];

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
    // Actual file-I/O: cumulative bytes read/written to disk and the smoothed
    // per-second rate. Reads include hash verification; writes include block
    // downloads. Distinct from network transfer — disk activity happens during a
    // scan with no peers at all.
    diskBytesRead: number;
    diskBytesWritten: number;
    diskReadRate: number;
    diskWriteRate: number;
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
    // True once the on-disk data has been hashed at least once. Until then the
    // torrent lives in the "verifying" group and can't transfer.
    verified: boolean;
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
    // Estimated start (source .torrent file time) and finish (latest output file
    // mtime), both epoch ms; 0 until determined. finishedChecking guards the
    // async output stat from running concurrently.
    startedAtMs: number;
    finishedAtMs: number;
    finishedChecking: boolean;
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
    private scheduler: SchedulerSettings;
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
    // Active *prioritized* file streams per infoHash: bounded-range HTTP requests
    // only. Whole-file requests (no Range / bytes=0-) stream at normal priority,
    // so they're excluded here and don't keep the torrent's priority alive.
    private readonly streamPriority = new Map<string, number>();
    // HTTP file-serving range requests the browser made: infoHash -> counters.
    // `outstanding`/`finished` count whole Range requests (streaming now vs.
    // done); `chunksRequested`/`chunksReturned` count the individual chunks those
    // requests span vs. have written back. Surfaced in the UI so the user can see
    // their specific range chunks and whether they're progressing.
    private readonly rangeStats = new Map<string, { outstanding: number; finished: number; chunksRequested: number; chunksReturned: number }>();
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
    // Disk-I/O rate sampling (EMA), from the global storage counters.
    private lastDiskRead = 0;
    private lastDiskWritten = 0;
    private diskReadRate = 0;
    private diskWriteRate = 0;
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
    // Dedicated bucket for prioritized torrents: half the global upload rate.
    private priorityUploadLimiter?: RateLimiter;
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

    // Where torrent data is written, shown in the UI footer.
    get outputDir(): string { return this.downloadDir; }

    // A copy of the current limits so the UI can display/edit them without
    // mutating our internal state directly.
    get schedulerSettings(): SchedulerSettings { return { ...this.scheduler }; }

    // Apply changed limits live to the running services, no restart needed.
    // Persisting to disk is the caller's job (it owns the config file).
    updateScheduler(changes: Partial<SchedulerSettings>): void {
        this.scheduler = { ...this.scheduler, ...changes };
        this.connectionBudget?.setMax(this.scheduler.activeConnections);
        this.chokeManager?.setSlots({
            uploadSlots: this.scheduler.uploadSlots,
            optimisticSlots: this.scheduler.optimisticUnchokeSlots,
        });
        // Owns both download and upload limiter rates (shared + priority buckets).
        this.applyBandwidthSplit();
        this.emit("update");
    }

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
        this.priorityUploadLimiter = new RateLimiter((this.scheduler.uploadMbps * BYTES_PER_MBIT) / 2);
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
        // Estimate the start time from the source .torrent file's creation time
        // (or its modified time where the platform doesn't track creation).
        const srcStat = await stat(sourcePath).catch(() => undefined);
        const startedAtMs = srcStat ? (srcStat.birthtimeMs || srcStat.mtimeMs) : 0;
        this.torrents.set(infoHash, {
            infoHash,
            name: meta.name,
            sourcePath,
            meta,
            started: false,
            starting: false,
            verified: false,
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
            startedAtMs,
            finishedAtMs: 0,
            finishedChecking: false,
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

    // Permanently remove a torrent: stop it, delete its source .torrent file(s)
    // so the watcher can't re-add it, delete its downloaded data, and forget all
    // its bookkeeping. Irreversible — the UI confirms before calling this.
    async deleteTorrent(infoHash: string): Promise<void> {
        const m = this.torrents.get(infoHash);
        if (!m) return;
        await m.torrent?.stop().catch(() => {});

        for (const [source, hash] of [...this.bySource.entries()]) {
            if (hash !== infoHash) continue;
            this.bySource.delete(source);
            await rm(source, { force: true }).catch(() => {});
        }

        const dirs = new Set<string>();
        for (const f of m.meta.files) {
            const full = path.join(this.downloadDir, ...f.path);
            await rm(full, { force: true }).catch(() => {});
            let dir = path.dirname(full);
            while (dir.length > this.downloadDir.length && dir.startsWith(this.downloadDir)) {
                dirs.add(dir);
                dir = path.dirname(dir);
            }
        }
        // Deepest first so a parent only gets pruned after its children. rmdir
        // throws on a non-empty dir, which we ignore — shared dirs stay put.
        for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
            await rmdir(dir).catch(() => {});
        }

        this.torrents.delete(infoHash);
        this.prioritized.delete(infoHash);
        this.forcedSlots.delete(infoHash);
        this.streamPriority.delete(infoHash);
        this.rangeStats.delete(infoHash);
        this.pausedPersisted.delete(infoHash);
        await this.saveState();
        this.emit("notice", `Deleted ${m.name}`);
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

    // The files inside a torrent, with the byte offset each one starts at in the
    // concatenated piece stream. Used by the HTTP file server to map a file (and
    // a Range within it) onto pieces.
    torrentFiles(infoHash: string): { index: number; path: string; length: number; offsetInTorrent: number }[] {
        const m = this.torrents.get(infoHash);
        if (!m) throw new Error(`Unknown torrent ${infoHash}`);
        return m.meta.files.map((f, index) => ({
            index,
            path: f.path.join("/"),
            length: f.length,
            offsetInTorrent: f.offsetInTorrent,
        }));
    }

    // Stream a byte range of one file out to `write`, fetching the covering
    // pieces in order and prioritizing them (and the whole torrent) while the
    // request is live. `write` should apply backpressure (resolve on drain) and
    // `isAborted` lets a disconnected client stop the fetch early. Increments the
    // torrent's range counters so the UI shows active/finished streams.
    async streamFile(config: {
        infoHash: string;
        fileIndex: number;
        start: number;
        endExclusive: number;
        write: (chunk: Buffer) => Promise<void>;
        isAborted: () => boolean;
    }): Promise<void> {
        const { infoHash, fileIndex, start, endExclusive, write, isAborted } = config;
        const m = this.torrents.get(infoHash);
        if (!m) throw new Error(`Unknown torrent ${infoHash}`);
        const file = m.meta.files[fileIndex];
        if (!file) throw new Error(`file index ${fileIndex} out of range: expected 0..${m.meta.files.length - 1}`);
        if (start < 0 || endExclusive > file.length || start >= endExclusive) {
            throw new Error(`range [${start}, ${endExclusive}) out of bounds for file of length ${file.length}`);
        }

        const absStart = file.offsetInTorrent + start;
        const absEnd = file.offsetInTorrent + endExclusive;
        const pieceLen = m.meta.pieceLength;
        const firstPiece = Math.floor(absStart / pieceLen);
        const lastPiece = Math.floor((absEnd - 1) / pieceLen);

        // A whole-file request (no Range header, or `bytes=0-`) is the browser
        // pulling the entire file, not seeking — prioritizing it would just
        // overload the scheduler with the whole file at once. Only bounded ranges
        // (a real seek/window) get prioritized; whole-file requests still stream,
        // just at normal priority.
        const prioritize = !(start === 0 && endExclusive === file.length);

        const stats = this.rangeStats.get(infoHash) || { outstanding: 0, finished: 0, chunksRequested: 0, chunksReturned: 0 };
        stats.outstanding++;
        // Every covered piece is one chunk this range request will hand back.
        stats.chunksRequested += lastPiece - firstPiece + 1;
        this.rangeStats.set(infoHash, stats);
        if (prioritize) {
            this.forcedSlots.set(infoHash, (this.forcedSlots.get(infoHash) || 0) + 1);
            this.streamPriority.set(infoHash, (this.streamPriority.get(infoHash) || 0) + 1);
            this.prioritized.add(infoHash);
            this.applyBandwidthSplit();
        }
        this.emit("update");

        const readaheadPieces = Math.max(1, Math.ceil(STREAM_READAHEAD_BYTES / pieceLen));
        try {
            const t = await this.ensureStartedTorrent(m);
            this.applyLimiter(m);
            for (let p = firstPiece; p <= lastPiece; p++) {
                if (isAborted()) return;
                // Prioritize a window of upcoming pieces, not just the one we're
                // about to read. The picker fetches priority pieces earliest-first,
                // so spare peer capacity prefetches the stream's next pieces in
                // order instead of scattering across rarest-first pieces — keeping
                // playback from stalling. Re-asserted each step so the window slides
                // forward as the read position advances.
                if (prioritize) {
                    const windowEnd = Math.min(lastPiece, p + readaheadPieces);
                    for (let w = p; w <= windowEnd; w++) t.pieceManager.prioritizePiece(w);
                }
                this.runScheduler(Date.now());
                t.kickRequests();
                if (!t.pieceManager.haveBitfield.get(p)) await this.waitForPiece(t, p);
                if (isAborted()) return;
                const pieceStart = p * pieceLen;
                const readBegin = Math.max(absStart, pieceStart) - pieceStart;
                const readEnd = Math.min(absEnd, pieceStart + pieceLengthAt(m.meta, p)) - pieceStart;
                if (readEnd <= readBegin) continue;
                const chunk = await t.storage.readBlock(p, readBegin, readEnd - readBegin);
                await write(chunk);
                stats.chunksReturned++;
                this.emit("update");
            }
        } finally {
            if (prioritize) {
                const remaining = (this.forcedSlots.get(infoHash) || 1) - 1;
                if (remaining <= 0) this.forcedSlots.delete(infoHash);
                else this.forcedSlots.set(infoHash, remaining);
                const streams = (this.streamPriority.get(infoHash) || 1) - 1;
                if (streams <= 0) {
                    // No prioritized stream left: drop the torrent's priority.
                    this.streamPriority.delete(infoHash);
                    this.prioritized.delete(infoHash);
                    this.applyBandwidthSplit();
                    this.applyLimiter(m);
                } else {
                    this.streamPriority.set(infoHash, streams);
                }
            }
            const s = this.rangeStats.get(infoHash) || { outstanding: 1, finished: 0, chunksRequested: 0, chunksReturned: 0 };
            s.outstanding = Math.max(0, s.outstanding - 1);
            s.finished++;
            this.rangeStats.set(infoHash, s);
            this.runScheduler(Date.now());
            this.emit("update");
        }
    }

    private mustHaveSlot(m: ManagedTorrent): boolean {
        return this.prioritized.has(m.infoHash) || this.forcedSlots.has(m.infoHash);
    }

    // When any torrent is prioritized, reserve half the global download AND
    // upload bandwidth for the priority bucket; the rest share the other half.
    private applyBandwidthSplit(): void {
        if (!this.downloadLimiter) return;
        const hasPriority = this.prioritized.size > 0;
        const fullDown = this.scheduler.downloadMbps * BYTES_PER_MBIT;
        this.downloadLimiter.setRate(hasPriority && fullDown / 2 || fullDown);
        this.priorityDownloadLimiter?.setRate(fullDown / 2);
        const fullUp = this.scheduler.uploadMbps * BYTES_PER_MBIT;
        this.uploadLimiter?.setRate(hasPriority && fullUp / 2 || fullUp);
        this.priorityUploadLimiter?.setRate(fullUp / 2);
    }

    private applyLimiter(m: ManagedTorrent): void {
        if (!m.torrent) return;
        const priority = this.prioritized.has(m.infoHash);
        m.torrent.setDownloadLimiter(priority && this.priorityDownloadLimiter || this.downloadLimiter);
        m.torrent.setUploadLimiter(priority && this.priorityUploadLimiter || this.uploadLimiter);
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
            diskBytesRead: diskIO.bytesRead,
            diskBytesWritten: diskIO.bytesWritten,
            diskReadRate: this.diskReadRate,
            diskWriteRate: this.diskWriteRate,
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
            verifying: [], downloading: [], seeding: [], downloadingQueued: [], downloadingNoPeers: [], seedingIdle: [],
        };
        for (const m of this.torrents.values()) buckets[this.sectionOf(m)].push(m);
        return SECTION_ORDER.map((key) => ({
            key,
            title: SECTION_TITLES[key],
            items: this.sortBucket(key, buckets[key]).map((m) => this.toView(m)),
        }));
    }

    // The verifying group is ordered the way we'll actually process it: the ones
    // being hashed right now on top, then everyone else in queue (iteration)
    // order. Every other group keeps the newest-torrent-first ordering.
    private sortBucket(key: SectionKey, items: ManagedTorrent[]): ManagedTorrent[] {
        if (key === "verifying") {
            return items.sort((a, b) => {
                const aActive = !!(a.torrent && !a.started);
                const bActive = !!(b.torrent && !b.started);
                if (aActive !== bActive) return aActive && -1 || 1;
                return a.queueOrder - b.queueOrder;
            });
        }
        return items.sort((a, b) => (b.meta.creationDate ?? 0) - (a.meta.creationDate ?? 0));
    }

    // ---- internals ----

    private sectionOf(m: ManagedTorrent): SectionKey {
        // Everything starts here: a torrent can't transfer until its on-disk data
        // has been hashed. It stays in this group whether it's actively being
        // scanned now or still waiting its turn, until verification completes.
        if (!m.verified && !m.error) return "verifying";
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

    // Estimate when the download finished from the latest modified time across
    // its output files. Runs once per torrent (guarded), result cached on m.
    private async captureFinishedAt(m: ManagedTorrent): Promise<void> {
        if (m.finishedChecking || m.finishedAtMs) return;
        m.finishedChecking = true;
        try {
            let latest = 0;
            for (const f of m.meta.files) {
                const s = await stat(path.join(this.downloadDir, ...f.path)).catch(() => undefined);
                if (s && s.mtimeMs > latest) latest = s.mtimeMs;
            }
            if (latest > 0) m.finishedAtMs = latest;
        } finally {
            m.finishedChecking = false;
        }
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
            pieceCount: m.meta.pieceHashes.length,
            startedAtMs: m.startedAtMs,
            finishedAtMs: m.finishedAtMs,
            prioritized: this.prioritized.has(m.infoHash),
            rangeOutstanding: this.rangeStats.get(m.infoHash)?.outstanding ?? 0,
            rangeFinished: this.rangeStats.get(m.infoHash)?.finished ?? 0,
            rangeChunksRequested: this.rangeStats.get(m.infoHash)?.chunksRequested ?? 0,
            rangeChunksReturned: this.rangeStats.get(m.infoHash)?.chunksReturned ?? 0,
        };
    }

    private displayState(m: ManagedTorrent): TorrentState {
        if (m.error) return "error";
        if (m.paused) return "paused";
        // Until the on-disk data has been hashed, the torrent is unusable:
        // "verifying" while a scan is actively running, "unverified" while it
        // waits its turn.
        if (m.torrent && !m.started) return m.torrent.verifyTarget === "temp" && "verifyTmp" || "verifyOut";
        if (!m.verified) return "unverified";
        if (!m.torrent) return "queued";
        const complete = this.isComplete(m);
        if (this.mode === "scan") {
            if (complete) return "done";
            if (m.torrent.hasMismatchedOutput) return "corrupted";
            return "checked";
        }
        if (this.mode === "scrape") return "ready";
        if (complete) {
            if (this.uploadedRecently(m)) return "seeding";
            return "idle";
        }
        if (m.downloadEnabled) return "downloading";
        if (m.torrent.hasMismatchedOutput) return "corrupted";
        return "queued";
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        const now = Date.now();
        const dt = Math.max(0.001, (now - this.lastTickMs) / 1000);
        this.lastTickMs = now;

        for (const m of this.torrents.values()) {
            const t = m.torrent;
            // A torrent that's only verifying (not yet started) isn't downloading.
            // Decay its rate and skip — verification reads show up as disk I/O,
            // not as a download.
            if (!t || !m.started) {
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
            // Once complete, estimate the finish time from the output files'
            // modified time (computed once, then cached).
            if (!m.finishedAtMs && this.isComplete(m)) void this.captureFinishedAt(m);
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

        const rInstDisk = Math.max(0, diskIO.bytesRead - this.lastDiskRead) / dt;
        const wInstDisk = Math.max(0, diskIO.bytesWritten - this.lastDiskWritten) / dt;
        this.diskReadRate = RATE_ALPHA * rInstDisk + (1 - RATE_ALPHA) * this.diskReadRate;
        this.diskWriteRate = RATE_ALPHA * wInstDisk + (1 - RATE_ALPHA) * this.diskWriteRate;
        this.lastDiskRead = diskIO.bytesRead;
        this.lastDiskWritten = diskIO.bytesWritten;

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
                m.verified = true;
                m.knownProgress = t.progress;
                // Baseline the rate counters at the post-verification byte counts
                // so the pieces we already had on disk aren't counted as a sudden
                // download on the next tick.
                m.lastDown = t.downloadedBytes;
                m.lastUp = t.uploadedBytes;
                m.lastProgressBytes = t.downloadedBytes;
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
