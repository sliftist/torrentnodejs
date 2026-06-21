import { EventEmitter } from "events";
import { Duplex } from "stream";
import { Transport } from "./transport";
import { Bitfield } from "./bitfield";

// BEP 3 peer wire protocol.
//
// 68-byte handshake: 0x13 + "BitTorrent protocol" (19) + 8 reserved zero
// + 20 info_hash + 20 peer_id. Then length-prefixed messages: 4-byte BE
// length (0 = keepalive), 1-byte message id, payload.

const PROTOCOL_STRING = Buffer.from("BitTorrent protocol", "ascii");
const HANDSHAKE_LEN = 68;
const HANDSHAKE_TIMEOUT_MS = 15_000;

export const MSG_CHOKE = 0;
export const MSG_UNCHOKE = 1;
export const MSG_INTERESTED = 2;
export const MSG_NOT_INTERESTED = 3;
export const MSG_HAVE = 4;
export const MSG_BITFIELD = 5;
export const MSG_REQUEST = 6;
export const MSG_PIECE = 7;
export const MSG_CANCEL = 8;
export const MSG_PORT = 9; // DHT — ignored

export interface PeerConnectionOptions {
    transport?: Transport;        // required if connecting outbound
    host?: string;                // required if connecting outbound
    port?: number;                // required if connecting outbound
    socket?: Duplex;              // if provided, skip transport.connectTcp (incoming peer)
    // Bytes already read off `socket` before this connection took over (used by
    // the shared listener, which must peek the handshake to route by info_hash).
    // Replayed through the parser once listeners are attached.
    initialData?: Buffer;
    infoHash: Buffer;
    peerId: Buffer;
    numPieces: number;
}

export interface PieceMessage {
    index: number;
    begin: number;
    block: Buffer;
}

// Events:
//   'handshake'   (peerId: Buffer)
//   'bitfield'    (Bitfield)
//   'have'        (index: number)
//   'choke'       ()
//   'unchoke'     ()
//   'interested'  ()
//   'notInterested' ()
//   'piece'       (PieceMessage)
//   'request'     ({ index, begin, length })
//   'cancel'      ({ index, begin, length })
//   'close'       ()
//   'error'       (err: Error)
export class PeerConnection extends EventEmitter {
    private socket?: Duplex;
    private buffer = Buffer.alloc(0);
    private handshakeDone = false;
    private destroyed = false;

    readonly remotePeerId: Buffer = Buffer.alloc(0);
    peerBitfield: Bitfield;

    // Cumulative payload bytes transferred over this connection. The global
    // choke manager samples these to rank peers by speed.
    bytesDownloaded = 0;
    bytesUploaded = 0;

    // Peer wire state (BEP 3 §"Peer protocol"):
    amChoking = true;
    amInterested = false;
    peerChoking = true;
    peerInterested = false;

    constructor(private readonly opts: PeerConnectionOptions) {
        super();
        this.peerBitfield = new Bitfield(opts.numPieces);
    }

    async connect(): Promise<void> {
        if (this.socket) throw new Error("PeerConnection already has a socket");
        let sock: Duplex;
        if (this.opts.socket) {
            sock = this.opts.socket;
        } else {
            if (!this.opts.transport || !this.opts.host || this.opts.port === undefined) {
                throw new Error("PeerConnection needs either socket or transport+host+port");
            }
            sock = await this.opts.transport.connectTcp({ host: this.opts.host, port: this.opts.port });
        }
        this.socket = sock;
        sock.on("data", (chunk: Buffer) => this.onData(chunk));
        sock.on("error", (err: Error) => this.onError(err));
        sock.on("close", () => this.onClose());
        sock.on("end", () => this.onClose());

        sock.write(buildHandshake(this.opts.infoHash, this.opts.peerId));

        // Replay any bytes the listener already consumed (the inbound handshake,
        // and possibly a trailing bitfield). Deferred to a microtask so the
        // handshake-wait listeners below are registered before it runs.
        if (this.opts.initialData && this.opts.initialData.length > 0) {
            const initial = this.opts.initialData;
            queueMicrotask(() => this.onData(initial));
        }

        // Wait for incoming handshake (both peers send their handshake immediately on connect)
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeListener("handshake", onShake);
                this.removeListener("error", onErr);
                this.removeListener("close", onClose);
                reject(new Error(`Handshake with ${this.opts.host}:${this.opts.port} timed out`));
                this.destroy();
            }, HANDSHAKE_TIMEOUT_MS);
            const onShake = () => {
                clearTimeout(timer);
                this.removeListener("error", onErr);
                this.removeListener("close", onClose);
                resolve();
            };
            const onErr = (e: Error) => {
                clearTimeout(timer);
                this.removeListener("handshake", onShake);
                this.removeListener("close", onClose);
                reject(e);
            };
            const onClose = () => {
                clearTimeout(timer);
                this.removeListener("handshake", onShake);
                this.removeListener("error", onErr);
                reject(new Error(`Peer ${this.opts.host}:${this.opts.port} closed before handshake`));
            };
            this.once("handshake", onShake);
            this.once("error", onErr);
            this.once("close", onClose);
        });
    }

    sendInterested(): void { this.sendKeyword(MSG_INTERESTED); this.amInterested = true; }
    sendNotInterested(): void { this.sendKeyword(MSG_NOT_INTERESTED); this.amInterested = false; }
    sendChoke(): void { this.sendKeyword(MSG_CHOKE); this.amChoking = true; }
    sendUnchoke(): void { this.sendKeyword(MSG_UNCHOKE); this.amChoking = false; }

    sendHave(index: number): void {
        const buf = Buffer.alloc(4 + 1 + 4);
        buf.writeUInt32BE(5, 0);
        buf.writeUInt8(MSG_HAVE, 4);
        buf.writeUInt32BE(index, 5);
        this.writeRaw(buf);
    }

    sendRequest(index: number, begin: number, length: number): void {
        const buf = Buffer.alloc(4 + 1 + 12);
        buf.writeUInt32BE(13, 0);
        buf.writeUInt8(MSG_REQUEST, 4);
        buf.writeUInt32BE(index, 5);
        buf.writeUInt32BE(begin, 9);
        buf.writeUInt32BE(length, 13);
        this.writeRaw(buf);
    }

    sendCancel(index: number, begin: number, length: number): void {
        const buf = Buffer.alloc(4 + 1 + 12);
        buf.writeUInt32BE(13, 0);
        buf.writeUInt8(MSG_CANCEL, 4);
        buf.writeUInt32BE(index, 5);
        buf.writeUInt32BE(begin, 9);
        buf.writeUInt32BE(length, 13);
        this.writeRaw(buf);
    }

    sendBitfield(bytes: Buffer): void {
        const buf = Buffer.alloc(4 + 1 + bytes.length);
        buf.writeUInt32BE(1 + bytes.length, 0);
        buf.writeUInt8(MSG_BITFIELD, 4);
        bytes.copy(buf, 5);
        this.writeRaw(buf);
    }

    sendPiece(index: number, begin: number, block: Buffer): void {
        const buf = Buffer.alloc(4 + 1 + 8 + block.length);
        buf.writeUInt32BE(9 + block.length, 0);
        buf.writeUInt8(MSG_PIECE, 4);
        buf.writeUInt32BE(index, 5);
        buf.writeUInt32BE(begin, 9);
        block.copy(buf, 13);
        this.writeRaw(buf);
        this.bytesUploaded += block.length;
    }

    sendKeepalive(): void {
        this.writeRaw(Buffer.from([0, 0, 0, 0]));
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        try { this.socket?.destroy(); } catch {}
    }

    private sendKeyword(id: number): void {
        const buf = Buffer.alloc(4 + 1);
        buf.writeUInt32BE(1, 0);
        buf.writeUInt8(id, 4);
        this.writeRaw(buf);
    }

    private writeRaw(buf: Buffer): void {
        if (this.destroyed || !this.socket) return;
        this.socket.write(buf);
    }

    private onData(chunk: Buffer): void {
        if (this.buffer.length === 0) this.buffer = Buffer.from(chunk);
        else this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshakeDone) {
            if (this.buffer.length < HANDSHAKE_LEN) return;
            let result: { reserved: Buffer; infoHash: Buffer; peerId: Buffer };
            try {
                result = parseHandshake(this.buffer.subarray(0, HANDSHAKE_LEN));
            } catch (e) {
                this.onError(e instanceof Error ? e : new Error(String(e)));
                return;
            }
            if (!result.infoHash.equals(this.opts.infoHash)) {
                this.onError(new Error("Peer sent wrong info_hash"));
                return;
            }
            (this as { remotePeerId: Buffer }).remotePeerId = result.peerId;
            this.handshakeDone = true;
            this.buffer = Buffer.from(this.buffer.subarray(HANDSHAKE_LEN));
            this.emit("handshake", result.peerId);
        }
        while (this.buffer.length >= 4) {
            const msgLen = this.buffer.readUInt32BE(0);
            if (msgLen === 0) {
                this.buffer = Buffer.from(this.buffer.subarray(4));
                this.emit("keepalive");
                continue;
            }
            // Sanity cap — a piece message is at most 9 + 128KB
            if (msgLen > 1 << 18) {
                this.onError(new Error(`Peer sent oversized message (${msgLen} bytes)`));
                return;
            }
            if (this.buffer.length < 4 + msgLen) return;
            const msg = this.buffer.subarray(4, 4 + msgLen);
            this.buffer = Buffer.from(this.buffer.subarray(4 + msgLen));
            this.dispatchMessage(msg);
        }
    }

    private dispatchMessage(msg: Buffer): void {
        if (msg.length === 0) return;
        const id = msg[0];
        const payload = msg.subarray(1);
        switch (id) {
            case MSG_CHOKE:
                this.peerChoking = true;
                this.emit("choke");
                break;
            case MSG_UNCHOKE:
                this.peerChoking = false;
                this.emit("unchoke");
                break;
            case MSG_INTERESTED:
                this.peerInterested = true;
                this.emit("interested");
                break;
            case MSG_NOT_INTERESTED:
                this.peerInterested = false;
                this.emit("notInterested");
                break;
            case MSG_HAVE: {
                if (payload.length < 4) return;
                const idx = payload.readUInt32BE(0);
                if (idx >= 0 && idx < this.opts.numPieces) {
                    this.peerBitfield.set(idx);
                    this.emit("have", idx);
                }
                break;
            }
            case MSG_BITFIELD: {
                const expectedBytes = Math.ceil(this.opts.numPieces / 8);
                if (payload.length !== expectedBytes) {
                    this.onError(new Error(`Bitfield length ${payload.length} != expected ${expectedBytes}`));
                    return;
                }
                this.peerBitfield = new Bitfield(this.opts.numPieces, payload);
                this.emit("bitfield", this.peerBitfield);
                break;
            }
            case MSG_REQUEST: {
                if (payload.length < 12) return;
                this.emit("request", {
                    index: payload.readUInt32BE(0),
                    begin: payload.readUInt32BE(4),
                    length: payload.readUInt32BE(8),
                });
                break;
            }
            case MSG_PIECE: {
                if (payload.length < 8) return;
                const index = payload.readUInt32BE(0);
                const begin = payload.readUInt32BE(4);
                const block = Buffer.from(payload.subarray(8));
                this.bytesDownloaded += block.length;
                this.emit("piece", { index, begin, block } as PieceMessage);
                break;
            }
            case MSG_CANCEL: {
                if (payload.length < 12) return;
                this.emit("cancel", {
                    index: payload.readUInt32BE(0),
                    begin: payload.readUInt32BE(4),
                    length: payload.readUInt32BE(8),
                });
                break;
            }
            case MSG_PORT:
                // DHT port — ignored (no DHT support)
                break;
            default:
                // Unknown message id — drop silently per BEP 3 robustness rules.
                break;
        }
    }

    private onError(err: Error): void {
        this.emit("error", err);
        this.destroy();
    }

    private onClose(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.emit("close");
    }
}

function buildHandshake(infoHash: Buffer, peerId: Buffer): Buffer {
    if (infoHash.length !== 20) throw new Error(`info_hash must be 20 bytes, was ${infoHash.length}`);
    if (peerId.length !== 20) throw new Error(`peer_id must be 20 bytes, was ${peerId.length}`);
    const buf = Buffer.alloc(HANDSHAKE_LEN);
    buf[0] = PROTOCOL_STRING.length;
    PROTOCOL_STRING.copy(buf, 1);
    // bytes 20..28 reserved (zero); byte 27 bit 0 = DHT, bit 4 = fast extension, etc.
    infoHash.copy(buf, 28);
    peerId.copy(buf, 48);
    return buf;
}

function parseHandshake(buf: Buffer): { reserved: Buffer; infoHash: Buffer; peerId: Buffer } {
    if (buf.length !== HANDSHAKE_LEN) throw new Error(`Handshake must be ${HANDSHAKE_LEN} bytes`);
    if (buf[0] !== PROTOCOL_STRING.length) throw new Error(`Bad protocol-string length ${buf[0]}`);
    if (!buf.subarray(1, 1 + PROTOCOL_STRING.length).equals(PROTOCOL_STRING)) {
        throw new Error("Bad protocol string");
    }
    return {
        reserved: Buffer.from(buf.subarray(20, 28)),
        infoHash: Buffer.from(buf.subarray(28, 48)),
        peerId: Buffer.from(buf.subarray(48, 68)),
    };
}
