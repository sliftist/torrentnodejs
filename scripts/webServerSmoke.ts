import assert from "assert";
import os from "os";
import path from "path";
import https from "https";
import { mkdtemp, copyFile, mkdir } from "fs/promises";
import { Duplex } from "stream";
import { EventEmitter } from "events";
import { parse as parseYaml } from "yaml";
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

interface Resp { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; }

function get(config: { port: number; path: string; headers?: Record<string, string> }): Promise<Resp> {
    return new Promise((resolve, reject) => {
        const req = https.get(
            { host: "127.0.0.1", port: config.port, path: config.path, headers: config.headers, rejectUnauthorized: false },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c as Buffer));
                res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
            },
        );
        req.on("error", reject);
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
    const pw = encodeURIComponent(server.password);

    // --- wrong password rejected ---
    const bad = await get({ port, path: `/status?password=nope` });
    assert.equal(bad.status, 401, "wrong password should be 401");

    // --- /status returns YAML listing the torrent ---
    const status = await get({ port, path: `/status?password=${pw}` });
    assert.equal(status.status, 200, "correct password /status should be 200");
    assert.match(String(status.headers["content-type"]), /yaml/, "status should be YAML");
    const parsed = parseYaml(status.body.toString()) as { torrents: { infoHash: string; rangeOutstanding: number }[] };
    assert.equal(parsed.torrents.length, 1, "should list one torrent");
    assert.equal(parsed.torrents[0].infoHash, infoHash, "status should include the torrent's infoHash");

    // --- / returns the HTML index with a file link ---
    const index = await get({ port, path: `/?password=${pw}` });
    assert.equal(index.status, 200, "index should be 200");
    assert.match(String(index.headers["content-type"]), /html/, "index should be HTML");
    assert.match(index.body.toString(), new RegExp(`/file/${infoHash}/0`), "index should link to the file");
    assert.match(index.body.toString(), /playVideo/, "index should have a video button");

    // --- a range request prioritizes the torrent and then hangs (no peers) ---
    let fileResolved = false;
    void get({ port, path: `/file/${infoHash}/0?password=${pw}`, headers: { range: "bytes=0-16383" } })
        .then(() => { fileResolved = true; })
        .catch(() => { fileResolved = true; });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(fileResolved, false, "file request should wait for the piece (no peers => pending)");
    assert.equal(manager.isPrioritized(infoHash), true, "an active range request should prioritize the torrent");
    const streaming = manager.views()[0];
    assert.equal(streaming.rangeOutstanding, 1, "one outstanding range request should be reported");

    await server.stop();
    await manager.stop();
    process.stdout.write("Web server smoke test passed.\n");
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`Web smoke FAILED: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
});
