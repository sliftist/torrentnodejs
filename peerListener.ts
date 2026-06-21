import { Duplex } from "stream";
import { Transport, TcpListenerLike } from "./transport";

const HANDSHAKE_LEN = 68;
// Drop a connection that hasn't sent a full handshake in this long. Port
// scanners and aborted clients open sockets and never speak.
const HANDSHAKE_TIMEOUT_MS = 15_000;

// Where in the 68-byte handshake the 20-byte info_hash sits:
// 1 (pstrlen) + 19 ("BitTorrent protocol") + 8 (reserved) = 28.
const INFO_HASH_OFFSET = 28;

export interface InboundPeer {
    socket: Duplex;
    info: { remoteAddress: string; remotePort: number };
    // The bytes already read off the socket (at least the full handshake).
    initialData: Buffer;
}

export type InboundHandler = (peer: InboundPeer) => void;

// One TCP listener shared by every torrent. Inbound peers send their handshake
// first; we read just enough to extract the info_hash, then hand the socket
// (plus the bytes we consumed) to whichever torrent owns that hash. There is no
// reason to bind a listener per torrent — a single port demuxed by info_hash is
// exactly how real clients work.
export class PeerListener {
    private listener?: TcpListenerLike;
    private readonly handlers = new Map<string, InboundHandler>();

    constructor(private readonly transport: Transport) {}

    async start(port: number): Promise<void> {
        if (this.listener) return;
        this.listener = await this.transport.listenTcp({ port });
        this.listener.on("connection", (sock: Duplex, info: { remoteAddress: string; remotePort: number }) => {
            this.onConnection(sock, info);
        });
    }

    port(): number {
        return this.listener?.port() || 0;
    }

    register(infoHashHex: string, handler: InboundHandler): void {
        this.handlers.set(infoHashHex, handler);
    }

    unregister(infoHashHex: string): void {
        this.handlers.delete(infoHashHex);
    }

    close(): void {
        this.listener?.close();
        this.listener = undefined;
        this.handlers.clear();
    }

    private onConnection(sock: Duplex, info: { remoteAddress: string; remotePort: number }): void {
        let buffer = Buffer.alloc(0);
        let settled = false;
        const timer = setTimeout(() => finish(false), HANDSHAKE_TIMEOUT_MS);

        const onData = (chunk: Buffer) => {
            buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
            if (buffer.length < HANDSHAKE_LEN) return;
            finish(true);
        };
        const onError = () => finish(false);
        const onClose = () => finish(false);

        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            sock.removeListener("data", onData);
            sock.removeListener("error", onError);
            sock.removeListener("close", onClose);
            if (!ok) { try { sock.destroy(); } catch { /* */ } return; }
            const infoHashHex = buffer.subarray(INFO_HASH_OFFSET, INFO_HASH_OFFSET + 20).toString("hex");
            const handler = this.handlers.get(infoHashHex);
            if (!handler) { try { sock.destroy(); } catch { /* */ } return; }
            handler({ socket: sock, info, initialData: buffer });
        };

        sock.on("data", onData);
        sock.on("error", onError);
        sock.on("close", onClose);
    }
}
