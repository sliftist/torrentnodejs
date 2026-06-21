import { EventEmitter } from "events";
import crypto from "crypto";
import { Transport } from "./transport";
import { TorrentMeta, pieceLengthAt } from "./torrentFile";
import { TrackerPool } from "./trackerPool";
import { PeerAddress } from "./trackerHttp";
import { PeerConnection } from "./peerConnection";
import { PieceManager, PieceSelection, BlockRequest, BLOCK_SIZE } from "./pieceManager";
import { Storage } from "./storage";
import { PeerListener, InboundPeer } from "./peerListener";
import { RateLimiter } from "./rateLimiter";
import { ChokeManager } from "./chokeManager";
import { ConnectionBudget } from "./connectionBudget";
import { DialStats } from "./dialStats";
import { yieldIfBlocked } from "./cooperativeYield";

// How many lifecycle phases the torrent actually runs:
//  - "scan":   open + SHA-1 verify on-disk pieces only. No network at all.
//  - "scrape": scan, then SCRAPE trackers for swarm stats (seeders/leechers/
//              peers). It never announces, never dials or accepts peers, and
//              transfers no data — just gathers swarm info before going full.
//  - "full":   every phase — announce, connect to peers, download and upload
//              (default).
export type RunMode = "scan" | "scrape" | "full";

export interface TorrentOptions {
    saveDir: string;
    selection?: PieceSelection;
    // See RunMode. Defaults to "full".
    mode?: RunMode;
    // Per-torrent connection cap (spec: 100).
    maxPeers?: number;
    pipelineDepth?: number;
    peerConnectTimeoutMs?: number;
    // If false, the torrent connects/announces but never requests block data.
    // The manager toggles this to implement the global download-slot budget.
    // Defaults to true.
    downloadEnabled?: boolean;
    // If true, assume the files already exist on disk and are complete for
    // our `selection`. We'll mark all selected pieces as "have" without
    // downloading or verifying. Useful for pure-seeder workloads.
    seedExisting?: boolean;
    // If true, SHA-1-check the selected pieces already on disk at startup and
    // mark the valid ones as "have". Unlike `seedExisting`, missing/corrupt
    // pieces are left to be downloaded.
    verifyExisting?: boolean;
    // Peers to try connecting to immediately, in addition to whatever
    // trackers report. Useful when the .torrent has no usable tracker.
    extraPeers?: { ip: string; port: number }[];
    // Shared services. When omitted the torrent runs standalone (used by the
    // demo scripts); the CLI always injects them so caps/rates/choking and the
    // single listener are global across every torrent.
    peerListener?: PeerListener;
    downloadLimiter?: RateLimiter;
    uploadLimiter?: RateLimiter;
    chokeManager?: ChokeManager;
    connectionBudget?: ConnectionBudget;
    // Counts outbound dials and the ones that fail, across all torrents.
    dialStats?: DialStats;
    // Port to report to trackers when there's no shared listener.
    listenPort?: number;
}

const DEFAULT_MAX_PEERS = 100;
const DEFAULT_PIPELINE_DEPTH = 8;
const DEFAULT_PEER_TIMEOUT_MS = 8000;

interface PeerMeta {
    ip: string;
    port: number;
    direction: "in" | "out";
}

// Events:
//   'piece'           (index: number)
//   'complete'        ()
//   'peer-connect'    ({ ip, port, peerId })
//   'peer-disconnect' ({ ip, port })
//   'error'           (err: Error)
export class Torrent extends EventEmitter {
    readonly meta: TorrentMeta;
    readonly pieceManager: PieceManager;
    readonly storage: Storage;
    private readonly transport: Transport;
    private readonly peerId: Buffer;
    private readonly tracker: TrackerPool;
    private readonly peerConnections = new Map<string, PeerConnection>();
    private readonly peerMeta = new Map<string, PeerMeta>();
    private readonly inflightPerPeer = new Map<string, number>();
    private readonly pumping = new Set<string>();
    // Pieces whose on-disk bytes we've SHA-1-confirmed before uploading, so we
    // never serve corrupt data. Checked once per piece per session.
    private readonly uploadVerified = new Set<number>();
    private readonly attempted = new Set<string>();
    private readonly maxPeers: number;
    private readonly pipelineDepth: number;
    private readonly peerConnectTimeoutMs: number;
    private readonly infoHashHex: string;
    private downloadEnabledField: boolean;
    private startedAt = 0;
    private stopped = false;
    private uploadedBytesField = 0;
    private readonly options: TorrentOptions;

    constructor(config: {
        meta: TorrentMeta;
        transport: Transport;
        peerId: Buffer;
        options: TorrentOptions;
    }) {
        super();
        this.meta = config.meta;
        this.transport = config.transport;
        this.peerId = config.peerId;
        this.options = config.options;
        this.infoHashHex = this.meta.infoHash.toString("hex");
        this.maxPeers = config.options.maxPeers ?? DEFAULT_MAX_PEERS;
        this.pipelineDepth = config.options.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH;
        this.peerConnectTimeoutMs = config.options.peerConnectTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
        this.downloadEnabledField = config.options.downloadEnabled ?? true;
        this.pieceManager = new PieceManager(config.meta, config.options.selection);
        this.storage = new Storage(config.meta, config.options.saveDir, this.pieceManager.selected);
        this.tracker = new TrackerPool({
            transport: this.transport,
            trackers: config.meta.announceList,
            // Scrape mode gathers swarm stats without joining the swarm.
            scrape: (config.options.mode ?? "full") === "scrape",
            params: () => ({
                infoHash: this.meta.infoHash,
                peerId: this.peerId,
                // Announce our actual listen port so trackers tell peers where to reach us.
                port: this.options.peerListener?.port() || this.options.listenPort || 6881,
                uploaded: this.uploadedBytesField,
                downloaded: this.pieceManager.downloadedBytes,
                left: Math.max(0, this.pieceManager.totalSelectedBytes - this.pieceManager.downloadedBytes),
                numWant: 100,
            }),
        });
    }

    get downloadedBytes(): number { return this.pieceManager.downloadedBytes; }
    get uploadedBytes(): number { return this.uploadedBytesField; }
    get totalSelectedBytes(): number { return this.pieceManager.totalSelectedBytes; }
    get progress(): number {
        const total = this.totalSelectedBytes;
        if (total === 0) return 1;
        return this.downloadedBytes / total;
    }
    get downloadEnabled(): boolean { return this.downloadEnabledField; }

    setDownloadEnabled(enabled: boolean): void {
        if (this.downloadEnabledField === enabled) return;
        this.downloadEnabledField = enabled;
        if (enabled) for (const key of this.peerConnections.keys()) void this.pumpRequests(key);
    }

    // Swap the download (request-pacing) limiter, e.g. to give a prioritized
    // torrent its own half-bandwidth bucket.
    setDownloadLimiter(limiter?: RateLimiter): void {
        this.options.downloadLimiter = limiter;
    }

    // Nudge every peer to re-pick blocks now (used after a priority change so a
    // newly-requested piece is fetched immediately rather than on the next event).
    kickRequests(): void {
        for (const key of this.peerConnections.keys()) void this.pumpRequests(key);
    }

    get peers(): { ip: string; port: number }[] {
        return [...this.peerMeta.values()].map((m) => ({ ip: m.ip, port: m.port }));
    }

    get connectedPeers(): number { return this.peerConnections.size; }

    // Peers that are currently unchoking us (we can download from them).
    get peersUnchokingUs(): number {
        let n = 0;
        for (const c of this.peerConnections.values()) if (!c.peerChoking) n++;
        return n;
    }

    // Peers we are currently unchoking (we can upload to them).
    get peersWeUnchoked(): number {
        let n = 0;
        for (const c of this.peerConnections.values()) if (!c.amChoking) n++;
        return n;
    }

    // Best swarm figures the trackers have reported.
    get swarmSeeders(): number {
        let n = 0;
        for (const s of this.tracker.trackerStats) if (typeof s.seeders === "number") n = Math.max(n, s.seeders);
        return n;
    }
    get swarmPeers(): number {
        let n = 0;
        for (const s of this.tracker.trackerStats) {
            if (typeof s.peers === "number") n = Math.max(n, s.peers);
            if (typeof s.seeders === "number" && typeof s.leechers === "number") n = Math.max(n, s.seeders + s.leechers);
        }
        return n;
    }
    get trackersTotal(): number { return this.meta.announceList.flat().length; }
    get trackersResponding(): number {
        let n = 0;
        for (const s of this.tracker.trackerStats) if (s.status === "ok") n++;
        return n;
    }

    // Richer per-peer info for the detail view.
    get peerDetails(): { ip: string; port: number; direction: "in" | "out"; peerChoking: boolean; amChoking: boolean; inflight: number }[] {
        const out: { ip: string; port: number; direction: "in" | "out"; peerChoking: boolean; amChoking: boolean; inflight: number }[] = [];
        for (const [key, conn] of this.peerConnections) {
            const meta = this.peerMeta.get(key);
            if (!meta) continue;
            out.push({
                ip: meta.ip,
                port: meta.port,
                direction: meta.direction,
                peerChoking: conn.peerChoking,
                amChoking: conn.amChoking,
                inflight: this.inflightPerPeer.get(key) || 0,
            });
        }
        return out;
    }

    get hasMismatchedOutput(): boolean { return this.storage.hasMismatchedOutput; }
    get trackerStats() { return this.tracker.trackerStats; }
    get pieceStates() { return this.pieceManager.pieceStates(); }
    get pieceCounts() { return this.pieceManager.pieceCounts; }
    get files() { return this.meta.files; }

    async start(): Promise<void> {
        if (this.startedAt) throw new Error("Torrent already started");
        this.startedAt = Date.now();
        await this.storage.open();

        const mode = this.options.mode ?? "full";

        if (this.options.seedExisting) {
            this.pieceManager.markAllSelectedDone();
        } else if (this.options.verifyExisting) {
            // Only a real download (full mode) seeds the temp file from salvaged
            // output; a scan just reports what's actually on disk.
            const have = await this.storage.verifyExistingPieces(this.pieceManager.selected, { importToTemp: mode === "full" });
            this.pieceManager.markHaves(have);
            await this.storage.finalizeFiles(this.pieceManager.haveBitfield);
            if (this.pieceManager.isComplete()) this.emit("complete");
        }

        // Scan-only mode stops here: drive checked, no network brought up.
        if (mode === "scan") return;

        this.tracker.on("tracker-error", (e: { url: string; error: Error }) => this.emit("tracker-error", e));

        // Scrape mode only scrapes the trackers for swarm stats — no listener,
        // no peer connections, no announce. Start the (scrape-configured) pool
        // and stop.
        if (mode === "scrape") {
            this.tracker.start();
            return;
        }

        // Inbound peers arrive through the single shared listener, demuxed by
        // info_hash. A standalone torrent without one simply can't be dialed.
        if (this.options.peerListener) {
            this.options.peerListener.register(this.infoHashHex, (peer) => this.acceptIncoming(peer));
        }

        this.tracker.on("peer", (p: PeerAddress) => this.tryAddPeer(p));
        this.tracker.start();

        if (this.options.extraPeers) {
            for (const p of this.options.extraPeers) this.tryAddPeer(p);
        }
    }

    async complete(): Promise<void> {
        if (this.pieceManager.isComplete()) return;
        await new Promise<void>((resolve, reject) => {
            this.once("complete", resolve);
            this.once("error", reject);
        });
    }

    async stop(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        this.options.peerListener?.unregister(this.infoHashHex);
        await this.tracker.stop();
        // destroy() doesn't emit 'close' (so disconnectPeer won't run); release
        // each held connection slot here exactly once. Each destroy sends a TCP
        // RST (synchronous encrypt + native send); yield if a peer-heavy torrent
        // would otherwise block the event loop tearing them all down.
        for (const [, conn] of this.peerConnections) {
            this.options.chokeManager?.remove(conn);
            this.options.connectionBudget?.release();
            try { conn.destroy(); } catch { /* */ }
            await yieldIfBlocked();
        }
        this.peerConnections.clear();
        this.peerMeta.clear();
        this.inflightPerPeer.clear();
        this.pumping.clear();
        await this.storage.close();
    }

    private full(): boolean { return (this.options.mode ?? "full") === "full"; }

    private acceptIncoming(peer: InboundPeer): void {
        if (this.stopped) { try { peer.socket.destroy(); } catch { /* */ } return; }
        if (this.peerConnections.size >= this.maxPeers) { try { peer.socket.destroy(); } catch { /* */ } return; }
        if (this.options.connectionBudget && !this.options.connectionBudget.acquire()) {
            try { peer.socket.destroy(); } catch { /* */ }
            return;
        }
        const key = `in:${peer.info.remoteAddress}:${peer.info.remotePort}:${Date.now()}`;
        const conn = new PeerConnection({
            socket: peer.socket,
            initialData: peer.initialData,
            infoHash: this.meta.infoHash,
            peerId: this.peerId,
            numPieces: this.meta.pieceHashes.length,
        });
        conn.on("error", () => { /* inbound junk is common; handled on close */ });
        // Wire message handlers BEFORE connect so a bitfield bundled with the
        // handshake (in initialData) isn't missed.
        this.peerMeta.set(key, { ip: peer.info.remoteAddress, port: peer.info.remotePort, direction: "in" });
        this.wirePeer(key, conn);
        conn.connect().then(() => {
            if (this.stopped) { conn.destroy(); return; }
            this.peerConnections.set(key, conn);
            this.inflightPerPeer.set(key, 0);
            if (this.full()) this.options.chokeManager?.add(conn);
            this.emit("peer-connect", { ip: peer.info.remoteAddress, port: peer.info.remotePort, peerId: conn.remotePeerId.toString("hex") });
            conn.sendBitfield(this.pieceManager.haveBitfield.bytes);
            void this.pumpRequests(key);
        }).catch(() => {
            this.peerMeta.delete(key);
            this.options.connectionBudget?.release();
        });
    }

    private tryAddPeer(p: PeerAddress): void {
        if (this.stopped) return;
        const key = `${p.ip}:${p.port}`;
        if (this.peerConnections.has(key) || this.attempted.has(key)) return;
        if (this.peerConnections.size >= this.maxPeers) return;
        if (this.options.connectionBudget && !this.options.connectionBudget.hasRoom) return;
        if (this.options.connectionBudget && !this.options.connectionBudget.acquire()) return;
        this.attempted.add(key);
        this.options.dialStats?.attempt();
        this.connectPeer(p, key).catch(() => {
            this.options.dialStats?.fail();
            this.attempted.delete(key);
            this.options.connectionBudget?.release();
        });
    }

    private async connectPeer(p: PeerAddress, key: string): Promise<void> {
        const conn = new PeerConnection({
            transport: this.transport,
            host: p.ip,
            port: p.port,
            infoHash: this.meta.infoHash,
            peerId: this.peerId,
            numPieces: this.meta.pieceHashes.length,
        });
        const timeout = setTimeout(() => conn.destroy(), this.peerConnectTimeoutMs);
        try {
            await conn.connect();
            clearTimeout(timeout);
        } catch (e) {
            clearTimeout(timeout);
            throw e;
        }
        if (this.stopped) { conn.destroy(); this.options.connectionBudget?.release(); return; }
        this.peerConnections.set(key, conn);
        this.peerMeta.set(key, { ip: p.ip, port: p.port, direction: "out" });
        this.inflightPerPeer.set(key, 0);
        if (this.full()) this.options.chokeManager?.add(conn);
        this.emit("peer-connect", { ip: p.ip, port: p.port, peerId: conn.remotePeerId.toString("hex") });
        this.wirePeer(key, conn);
        conn.sendBitfield(this.pieceManager.haveBitfield.bytes);
    }

    private wirePeer(key: string, conn: PeerConnection): void {
        conn.on("bitfield", (bf) => {
            this.pieceManager.addPeer(key, bf);
            conn.sendInterested();
            void this.pumpRequests(key);
        });
        conn.on("have", (i: number) => {
            this.pieceManager.updatePeerHave(key, i);
            void this.pumpRequests(key);
        });
        conn.on("unchoke", () => void this.pumpRequests(key));
        conn.on("choke", () => { /* in-flight requests re-issue if the peer disconnects */ });
        conn.on("piece", (msg: { index: number; begin: number; block: Buffer }) => {
            const cur = this.inflightPerPeer.get(key) || 0;
            this.inflightPerPeer.set(key, Math.max(0, cur - 1));
            this.handleBlock(key, msg.index, msg.begin, msg.block).catch((e) => this.emit("error", e));
        });
        conn.on("request", (req: { index: number; begin: number; length: number }) => {
            this.serveBlock(conn, req).catch(() => conn.destroy());
        });
        conn.on("close", () => this.disconnectPeer(key));
        conn.on("error", () => this.disconnectPeer(key));
    }

    private async serveBlock(conn: PeerConnection, req: { index: number; begin: number; length: number }): Promise<void> {
        if (!this.full()) return;
        if (conn.amChoking) return;
        if (!this.pieceManager.haveBitfield.get(req.index)) return;
        const MAX_BLOCK = 128 * 1024;
        if (req.length === 0 || req.length > MAX_BLOCK) return;
        if (!await this.verifyPieceForUpload(req.index)) return;
        if (this.options.uploadLimiter) await this.options.uploadLimiter.take(req.length);
        if (this.stopped || conn.amChoking) return;
        const block = await this.storage.readBlock(req.index, req.begin, req.length);
        conn.sendPiece(req.index, req.begin, block);
        this.uploadedBytesField += block.length;
        this.emit("uploaded", { peerId: conn.remotePeerId.toString("hex"), bytes: block.length });
    }

    // Confirm a piece's on-disk bytes still hash correctly before we upload any
    // of it. If the disk content has gone bad, drop the piece back to "needed"
    // so it's re-downloaded instead of serving corruption to a peer.
    private async verifyPieceForUpload(index: number): Promise<boolean> {
        if (this.uploadVerified.has(index)) return true;
        const piece = await this.storage.readBlock(index, 0, pieceLengthAt(this.meta, index));
        const ok = crypto.createHash("sha1").update(piece).digest().equals(this.meta.pieceHashes[index]);
        if (ok) {
            this.uploadVerified.add(index);
            return true;
        }
        this.pieceManager.invalidatePiece(index);
        return false;
    }

    private async handleBlock(key: string, index: number, begin: number, block: Buffer): Promise<void> {
        const req: BlockRequest = { pieceIndex: index, begin, length: block.length };
        const result = this.pieceManager.addBlock(req, block, key);
        if (result.kind === "stored" || result.kind === "complete") {
            // Endgame: cancel the same block we'd requested from other peers.
            for (const c of result.canceled) {
                const other = this.peerConnections.get(c.peerId);
                if (other) other.sendCancel(c.pieceIndex, c.begin, c.length);
            }
        }
        if (result.kind === "complete") {
            await this.storage.writePiece(index, result.piece);
            await this.storage.finalizeFiles(this.pieceManager.haveBitfield);
            for (const c of this.peerConnections.values()) c.sendHave(index);
            this.emit("piece", index);
            if (this.pieceManager.isComplete()) this.emit("complete");
        }
        void this.pumpRequests(key);
    }

    private async pumpRequests(key: string): Promise<void> {
        if (!this.full() || !this.downloadEnabledField || this.stopped) return;
        if (this.pumping.has(key)) return;
        const initial = this.peerConnections.get(key);
        if (!initial || initial.peerChoking) return;
        this.pumping.add(key);
        try {
            while (true) {
                let inflight = this.inflightPerPeer.get(key) || 0;
                if (inflight >= this.pipelineDepth) break;
                // Pace requests against the global download budget BEFORE picking,
                // so pick→mark→send stays synchronous (no duplicate requests).
                if (this.options.downloadLimiter) await this.options.downloadLimiter.take(BLOCK_SIZE);
                const conn = this.peerConnections.get(key);
                if (this.stopped || !conn || conn.peerChoking) break;
                const req = this.pieceManager.pickBlock(key);
                if (!req) break;
                this.pieceManager.markInflight(req, key);
                inflight++;
                this.inflightPerPeer.set(key, inflight);
                conn.sendRequest(req.pieceIndex, req.begin, req.length);
            }
        } finally {
            this.pumping.delete(key);
        }
    }

    private disconnectPeer(key: string): void {
        if (this.stopped) return;
        const conn = this.peerConnections.get(key);
        const meta = this.peerMeta.get(key);
        if (conn) {
            this.options.chokeManager?.remove(conn);
            try { conn.destroy(); } catch { /* */ }
            this.peerConnections.delete(key);
            this.options.connectionBudget?.release();
        }
        this.peerMeta.delete(key);
        this.inflightPerPeer.delete(key);
        this.pumping.delete(key);
        this.pieceManager.removePeer(key);
        // Only a peer we actually connected emits a disconnect.
        if (conn && meta) this.emit("peer-disconnect", { ip: meta.ip, port: meta.port });
    }
}
