import crypto from "crypto";
import { EventEmitter } from "events";
import { Transport } from "./transport";
import { TorrentMeta } from "./torrentFile";
import { TrackerPool } from "./trackerPool";
import { PeerAddress } from "./trackerHttp";
import { PeerConnection } from "./peerConnection";
import { PieceManager, PieceSelection, BlockRequest } from "./pieceManager";
import { Storage } from "./storage";
import { TcpListenerLike } from "./transport";
import { Duplex } from "stream";

export interface TorrentOptions {
    saveDir: string;
    selection?: PieceSelection;
    maxPeers?: number;
    pipelineDepth?: number;
    peerConnectTimeoutMs?: number;
    // Open a TCP listener on this port so other peers can connect to us and
    // download what we already have. If 0 or undefined, no inbound listener.
    listenPort?: number;
    // If true, assume the files already exist on disk and are complete for
    // our `selection`. We'll mark all selected pieces as "have" without
    // downloading or verifying. Useful for pure-seeder workloads.
    seedExisting?: boolean;
    // If true, SHA-1-check the selected pieces already on disk at startup and
    // mark the valid ones as "have". Unlike `seedExisting`, missing/corrupt
    // pieces are left to be downloaded. Use this to resume a partial download
    // or to confirm a seed without trusting the disk blindly.
    verifyExisting?: boolean;
    // Peers to try connecting to immediately, in addition to whatever
    // trackers report. Useful when the .torrent has no usable tracker.
    extraPeers?: { ip: string; port: number }[];
}

const DEFAULT_MAX_PEERS = 40;
const DEFAULT_PIPELINE_DEPTH = 5;
const DEFAULT_PEER_TIMEOUT_MS = 8000;

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
    private readonly inflightPerPeer = new Map<string, number>();
    private readonly attempted = new Set<string>();
    private readonly maxPeers: number;
    private readonly pipelineDepth: number;
    private readonly peerConnectTimeoutMs: number;
    private startedAt = 0;
    private stopped = false;
    private listener?: TcpListenerLike;
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
        this.maxPeers = config.options.maxPeers ?? DEFAULT_MAX_PEERS;
        this.pipelineDepth = config.options.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH;
        this.peerConnectTimeoutMs = config.options.peerConnectTimeoutMs ?? DEFAULT_PEER_TIMEOUT_MS;
        this.pieceManager = new PieceManager(config.meta, config.options.selection);
        this.storage = new Storage(config.meta, config.options.saveDir, this.pieceManager.selected);
        this.tracker = new TrackerPool({
            transport: this.transport,
            trackers: config.meta.announceList,
            params: () => ({
                infoHash: this.meta.infoHash,
                peerId: this.peerId,
                // Announce our actual listen port so trackers tell peers where to reach us
                port: this.listener?.port() || config.options.listenPort || 6881,
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
        return total === 0 ? 1 : this.downloadedBytes / total;
    }
    get listenPort(): number | undefined { return this.listener?.port(); }
    get peers(): { ip: string; port: number }[] {
        return this.peerDetails.map((p) => ({ ip: p.ip, port: p.port }));
    }

    // Richer per-peer info for the detail view. Inbound peers are keyed with an
    // "in:" prefix; everything else is an outbound dial.
    get peerDetails(): { ip: string; port: number; direction: "in" | "out"; peerChoking: boolean; amChoking: boolean; inflight: number }[] {
        const out: { ip: string; port: number; direction: "in" | "out"; peerChoking: boolean; amChoking: boolean; inflight: number }[] = [];
        for (const [key, conn] of this.peerConnections) {
            const direction = key.startsWith("in:") ? "in" : "out";
            const stripped = direction === "in" ? key.slice(3) : key;
            const lastColon = stripped.lastIndexOf(":");
            const ip = direction === "in" ? stripped.slice(0, stripped.indexOf(":")) : stripped.slice(0, lastColon);
            const port = parseInt(direction === "in" ? stripped.split(":")[1] : stripped.slice(lastColon + 1), 10);
            out.push({
                ip,
                port,
                direction,
                peerChoking: conn.peerChoking,
                amChoking: conn.amChoking,
                inflight: this.inflightPerPeer.get(key) || 0,
            });
        }
        return out;
    }

    get trackerStats() { return this.tracker.trackerStats; }
    get pieceStates() { return this.pieceManager.pieceStates(); }
    get pieceCounts() { return this.pieceManager.pieceCounts; }
    get files() { return this.meta.files; }

    async start(): Promise<void> {
        if (this.startedAt) throw new Error("Torrent already started");
        this.startedAt = Date.now();
        await this.storage.open();

        // Pure-seeder mode: assume on-disk file already contains every selected piece.
        if (this.options.seedExisting) {
            this.pieceManager.markAllSelectedDone();
        } else if (this.options.verifyExisting) {
            // Resume: SHA-1-check what's on disk and adopt the valid pieces.
            const have = await this.storage.verifyExistingPieces(this.pieceManager.selected);
            this.pieceManager.markHaves(have);
            if (this.pieceManager.isComplete()) this.emit("complete");
        }

        // Open a TCP listener for inbound peers.
        if (this.options.listenPort !== undefined) {
            this.listener = await this.transport.listenTcp({ port: this.options.listenPort });
            this.listener.on("connection", (sock: Duplex, info: { remoteAddress: string; remotePort: number }) => {
                this.acceptIncoming(sock, info).catch(() => {/* peer bailed; ignore */});
            });
        }

        this.tracker.on("peer", (p: PeerAddress) => this.tryAddPeer(p));
        this.tracker.on("tracker-error", (e: { url: string; error: Error }) => this.emit("tracker-error", e));
        this.tracker.start();

        // Immediately try any directly-supplied peers (no tracker needed).
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
        this.listener?.close();
        this.listener = undefined;
        await this.tracker.stop();
        for (const c of this.peerConnections.values()) c.destroy();
        this.peerConnections.clear();
        await this.storage.close();
    }

    private async acceptIncoming(sock: Duplex, info: { remoteAddress: string; remotePort: number }): Promise<void> {
        if (this.stopped) { try { sock.destroy(); } catch {} return; }
        const key = `in:${info.remoteAddress}:${info.remotePort}:${Date.now()}`;
        const conn = new PeerConnection({
            socket: sock,
            infoHash: this.meta.infoHash,
            peerId: this.peerId,
            numPieces: this.meta.pieceHashes.length,
        });
        // Swallow handshake/network errors on inbound peers — they're often
        // just port scanners or aborted clients. Logging them as torrent
        // errors would be noisy and not actionable.
        conn.on("error", () => { /* logged below if it disconnects */ });
        try {
            await conn.connect();
        } catch {
            return;
        }
        this.peerConnections.set(key, conn);
        this.inflightPerPeer.set(key, 0);
        this.emit("peer-connect", { ip: info.remoteAddress, port: info.remotePort, peerId: conn.remotePeerId.toString("hex") });
        this.wirePeer(key, conn);
        conn.sendBitfield(this.pieceManager.haveBitfield.bytes);
        conn.sendUnchoke();
    }

    private tryAddPeer(p: PeerAddress): void {
        if (this.stopped) return;
        const key = `${p.ip}:${p.port}`;
        if (this.peerConnections.has(key) || this.attempted.has(key)) return;
        if (this.peerConnections.size >= this.maxPeers) return;
        this.attempted.add(key);
        this.connectPeer(p).catch(() => { /* not all peers respond — that's fine */ });
    }

    private async connectPeer(p: PeerAddress): Promise<void> {
        const key = `${p.ip}:${p.port}`;
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
        } catch {
            clearTimeout(timeout);
            this.attempted.delete(key); // allow retry later
            return;
        }
        this.peerConnections.set(key, conn);
        this.inflightPerPeer.set(key, 0);
        this.emit("peer-connect", { ip: p.ip, port: p.port, peerId: conn.remotePeerId.toString("hex") });
        this.wirePeer(key, conn);
    }

    private wirePeer(key: string, conn: PeerConnection): void {
        conn.on("bitfield", (bf) => {
            this.pieceManager.addPeer(key, bf);
            conn.sendInterested();
            this.pumpRequests(key);
        });
        conn.on("have", (i: number) => {
            this.pieceManager.updatePeerHave(key, i);
            this.pumpRequests(key);
        });
        conn.on("unchoke", () => this.pumpRequests(key));
        conn.on("choke", () => { /* in-flight requests will be re-issued if peer disconnects */ });
        conn.on("piece", (msg: { index: number; begin: number; block: Buffer }) => {
            const cur = this.inflightPerPeer.get(key) || 0;
            this.inflightPerPeer.set(key, Math.max(0, cur - 1));
            this.handleBlock(key, conn, msg.index, msg.begin, msg.block).catch((e) => this.emit("error", e));
        });
        // Seeding side: respond to block requests.
        conn.on("request", (req: { index: number; begin: number; length: number }) => {
            this.serveBlock(conn, req).catch(() => conn.destroy());
        });
        conn.on("close", () => this.disconnectPeer(key));
        conn.on("error", () => this.disconnectPeer(key));
    }

    private async serveBlock(conn: PeerConnection, req: { index: number; begin: number; length: number }): Promise<void> {
        if (conn.amChoking) return;
        if (!this.pieceManager.haveBitfield.get(req.index)) return;
        const MAX_BLOCK = 128 * 1024; // sanity cap (BEP 3 strongly suggests <= 128KB)
        if (req.length === 0 || req.length > MAX_BLOCK) return;
        const block = await this.storage.readBlock(req.index, req.begin, req.length);
        conn.sendPiece(req.index, req.begin, block);
        this.uploadedBytesField += block.length;
        this.emit("uploaded", { peerId: conn.remotePeerId.toString("hex"), bytes: block.length });
    }

    private async handleBlock(key: string, _conn: PeerConnection, index: number, begin: number, block: Buffer): Promise<void> {
        const req: BlockRequest = { pieceIndex: index, begin, length: block.length };
        const result = this.pieceManager.addBlock(req, block, key);
        if (result.kind === "complete") {
            await this.storage.writePiece(index, result.piece);
            for (const c of this.peerConnections.values()) c.sendHave(index);
            this.emit("piece", index);
            if (this.pieceManager.isComplete()) this.emit("complete");
        }
        this.pumpRequests(key);
    }

    private pumpRequests(key: string): void {
        const conn = this.peerConnections.get(key);
        if (!conn) return;
        if (conn.peerChoking) return;
        let inflight = this.inflightPerPeer.get(key) || 0;
        while (inflight < this.pipelineDepth) {
            const req = this.pieceManager.pickBlock(key);
            if (!req) break;
            this.pieceManager.markInflight(req, key);
            conn.sendRequest(req.pieceIndex, req.begin, req.length);
            inflight++;
        }
        this.inflightPerPeer.set(key, inflight);
    }

    private disconnectPeer(key: string): void {
        const conn = this.peerConnections.get(key);
        if (!conn) return;
        try { conn.destroy(); } catch { /* */ }
        this.peerConnections.delete(key);
        this.inflightPerPeer.delete(key);
        this.pieceManager.removePeer(key);
        const [ip, portStr] = key.split(":");
        this.emit("peer-disconnect", { ip, port: parseInt(portStr, 10) });
    }
}
