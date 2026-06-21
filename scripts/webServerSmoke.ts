import assert from "assert";
import os from "os";
import path from "path";
import { mkdtemp, copyFile, mkdir } from "fs/promises";
import { Duplex } from "stream";
import { EventEmitter } from "events";
import WebSocket from "ws";
import { Transport, UdpSocketLike, TcpListenerLike } from "../transport";
import { TorrentManager } from "../cli/torrentManager";
import { DEFAULT_SCHEDULER } from "../cli/config";
import { WebCommandServer } from "../cli/web/webServer";

const stubTransport: Transport = {
    async fetch() { throw new Error("offline"); },
    async connectTcp(): Promise<Duplex> { throw new Error("offline"); },
    openUdp(): UdpSocketLike { return new EventEmitter() as unknown as UdpSocketLike; },
    async resolve() { throw new Error("offline"); },
    async listenTcp(): Promise<TcpListenerLike> {
        const l = new EventEmitter() as unknown as TcpListenerLike;
        (l as unknown as { port: () => number }).port = () => 6881;
        (l as unknown as { close: () => void }).close = () => {};
        return l;
    },
};

interface RpcMsg { type: string; id: string; data?: unknown; }

function rpc(ws: WebSocket, type: string, data: unknown, id: string): Promise<RpcMsg> {
    return new Promise((resolve, reject) => {
        const onMsg = (raw: WebSocket.RawData) => {
            const msg = JSON.parse(raw.toString()) as RpcMsg;
            if (msg.id !== id) return;
            ws.off("message", onMsg);
            resolve(msg);
        };
        ws.on("message", onMsg);
        ws.send(JSON.stringify({ type, id, data }));
        setTimeout(() => reject(new Error(`timeout waiting for ${id}`)), 5000);
    });
}

async function main() {
    const work = await mkdtemp(path.join(os.tmpdir(), "bt-web-smoke-"));
    await mkdir(path.join(work, "dl"), { recursive: true });

    const manager = new TorrentManager({
        transport: stubTransport,
        downloadDir: path.join(work, "dl"),
        scheduler: { ...DEFAULT_SCHEDULER },
        listenPort: 6881,
        stateDir: work,
        mode: "full",
    });
    await manager.start();

    const torrentPath = path.join(work, "bbb.torrent");
    await copyFile(path.join(__dirname, "..", "big-buck-bunny.torrent"), torrentPath);
    await manager.addSourceFile(torrentPath);
    const infoHash = manager.views()[0].infoHash;

    const server = new WebCommandServer({ manager, port: 0, host: "127.0.0.1" });
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    const port = addr.port;

    const connect = () => new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
    });

    // --- wrong password rejected ---
    let ws = await connect();
    const bad = await rpc(ws, "auth", { password: "nope" }, "a1");
    assert.equal(bad.type, "error", "wrong password should be rejected");
    ws.close();

    // --- correct password + commands ---
    ws = await connect();
    const ok = await rpc(ws, "auth", { password: server.password }, "a2");
    assert.equal(ok.type, "return", "correct password should authenticate");

    const list = await rpc(ws, "call", { method: "listTorrents" }, "c1");
    assert.equal(list.type, "return", "listTorrents should return");
    const listData = list.data as { torrents: { infoHash: string }[] };
    assert.equal(listData.torrents.length, 1, "should list one torrent");
    assert.equal(listData.torrents[0].infoHash, infoHash);

    const prio = await rpc(ws, "call", { method: "prioritizeTorrent", args: { infoHash } }, "c2");
    assert.equal(prio.type, "return", "prioritizeTorrent should return");
    assert.equal(manager.isPrioritized(infoHash), true, "torrent should now be prioritized");

    const unknown = await rpc(ws, "call", { method: "doesNotExist" }, "c3");
    assert.equal(unknown.type, "error", "unknown method should error");

    // requestBlock for an offline torrent must hang (no peers) — verify it does
    // NOT resolve quickly, then move on.
    let blockResolved = false;
    void rpc(ws, "call", { method: "requestBlock", args: { infoHash, pieceIndex: 0, begin: 0, length: 16384 } }, "c4")
        .then(() => { blockResolved = true; })
        .catch(() => { blockResolved = true; });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(blockResolved, false, "requestBlock should wait for the piece (no peers => pending)");

    ws.close();
    await server.stop();
    await manager.stop();
    process.stdout.write("Web server smoke test passed.\n");
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`Web smoke FAILED: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
});
