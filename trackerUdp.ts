import crypto from "crypto";
import { Transport, UdpSocketLike } from "./transport";
import { AnnounceParams, TrackerAnnounceResult, PeerAddress } from "./trackerHttp";

// BEP 15. UDP trackers use a two-step protocol: first a connect (which returns
// a 64-bit connection_id valid for ~60 s), then an announce that includes it.

const PROTOCOL_ID = 0x41727101980n;
const ACTION_CONNECT = 0;
const ACTION_ANNOUNCE = 1;
const ACTION_ERROR = 3;

const CONNECT_TIMEOUT_MS = 5_000;
const ANNOUNCE_TIMEOUT_MS = 10_000;

export async function announceUdp(transport: Transport, trackerUrl: string, params: AnnounceParams): Promise<TrackerAnnounceResult> {
    const u = new URL(trackerUrl);
    const host = u.hostname;
    const port = parseInt(u.port, 10);
    if (!host || !Number.isFinite(port)) {
        throw new Error(`Invalid UDP tracker URL "${trackerUrl}"`);
    }
    const destIP = await transport.resolve(host);
    const sock = transport.openUdp();
    try {
        const connectionId = await udpConnect({ sock, destIP, destPort: port });
        return await udpAnnounce({ sock, destIP, destPort: port, connectionId, params });
    } finally {
        sock.close();
    }
}

function udpConnect(opts: { sock: UdpSocketLike; destIP: string; destPort: number }): Promise<Buffer> {
    const txId = crypto.randomBytes(4);
    const req = Buffer.alloc(16);
    req.writeBigUInt64BE(PROTOCOL_ID, 0);
    req.writeUInt32BE(ACTION_CONNECT, 8);
    txId.copy(req, 12);

    return new Promise<Buffer>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); opts.sock.off("message", onMessage); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`UDP connect to ${opts.destIP}:${opts.destPort} timed out`)); }, CONNECT_TIMEOUT_MS);
        const onMessage = (msg: Buffer) => {
            if (msg.length < 16) return;
            if (msg.readUInt32BE(0) !== ACTION_CONNECT) return;
            if (!msg.subarray(4, 8).equals(txId)) return;
            cleanup();
            resolve(Buffer.from(msg.subarray(8, 16)));
        };
        opts.sock.on("message", onMessage);
        opts.sock.send({ destIP: opts.destIP, destPort: opts.destPort, payload: req });
    });
}

function udpAnnounce(opts: {
    sock: UdpSocketLike;
    destIP: string;
    destPort: number;
    connectionId: Buffer;
    params: AnnounceParams;
}): Promise<TrackerAnnounceResult> {
    const { params } = opts;
    const txId = crypto.randomBytes(4);
    const req = Buffer.alloc(98);
    opts.connectionId.copy(req, 0);
    req.writeUInt32BE(ACTION_ANNOUNCE, 8);
    txId.copy(req, 12);
    params.infoHash.copy(req, 16);
    params.peerId.copy(req, 36);
    req.writeBigUInt64BE(BigInt(params.downloaded), 56);
    req.writeBigUInt64BE(BigInt(params.left), 64);
    req.writeBigUInt64BE(BigInt(params.uploaded), 72);
    const eventCode = params.event === "completed" ? 1
        : params.event === "started" ? 2
        : params.event === "stopped" ? 3
        : 0;
    req.writeUInt32BE(eventCode, 80);
    req.writeUInt32BE(0, 84);                       // IP (0 = let tracker infer)
    crypto.randomBytes(4).copy(req, 88);            // key (per BEP 15)
    req.writeInt32BE(params.numWant ?? -1, 92);     // num_want, -1 = default
    req.writeUInt16BE(params.port, 96);

    return new Promise<TrackerAnnounceResult>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); opts.sock.off("message", onMessage); };
        const timer = setTimeout(() => { cleanup(); reject(new Error(`UDP announce to ${opts.destIP}:${opts.destPort} timed out`)); }, ANNOUNCE_TIMEOUT_MS);
        const onMessage = (msg: Buffer) => {
            if (msg.length < 8) return;
            if (!msg.subarray(4, 8).equals(txId)) return;
            const action = msg.readUInt32BE(0);
            if (action === ACTION_ERROR) {
                cleanup();
                reject(new Error(`UDP tracker error: ${msg.subarray(8).toString("utf8")}`));
                return;
            }
            if (action !== ACTION_ANNOUNCE) return;
            if (msg.length < 20) { cleanup(); reject(new Error("Truncated UDP announce response")); return; }
            cleanup();
            const interval = msg.readUInt32BE(8);
            const leechers = msg.readUInt32BE(12);
            const seeders = msg.readUInt32BE(16);
            const peers: PeerAddress[] = [];
            for (let i = 20; i + 6 <= msg.length; i += 6) {
                const ip = `${msg[i]}.${msg[i + 1]}.${msg[i + 2]}.${msg[i + 3]}`;
                const port = msg.readUInt16BE(i + 4);
                if (port !== 0) peers.push({ ip, port });
            }
            resolve({ interval, peers, seeders, leechers });
        };
        opts.sock.on("message", onMessage);
        opts.sock.send({ destIP: opts.destIP, destPort: opts.destPort, payload: req });
    });
}
