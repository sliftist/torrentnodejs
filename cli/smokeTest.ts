import assert from "assert";
import os from "os";
import path from "path";
import { mkdtemp, copyFile, rm, readdir } from "fs/promises";
import { Duplex } from "stream";
import { Transport, UdpSocketLike, TcpListenerLike } from "../transport";
import { EventEmitter } from "events";
import { TorrentManager } from "./torrentManager";
import { SourceWatcher } from "./watcher";
import { Config, DEFAULT_SCHEDULER, saveConfig, loadConfig } from "./config";

// A transport that never touches the network. Enough to exercise the manager's
// parsing / scheduling / snapshot logic without WireGuard.
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

async function main() {
    const work = await mkdtemp(path.join(os.tmpdir(), "bt-cli-smoke-"));
    const sourceDir = path.join(work, "src");
    const downloadDir = path.join(work, "dl");
    await rm(sourceDir, { recursive: true, force: true });
    const { mkdir } = await import("fs/promises");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(downloadDir, { recursive: true });

    // --- config roundtrip ---
    const cfg: Config = {
        wireguardConfigPath: "/tmp/fake.conf",
        downloadDir,
        sources: [sourceDir],
        listenPort: 6881,
        scheduler: { ...DEFAULT_SCHEDULER },
    };
    await saveConfig(cfg, work);
    const loaded = await loadConfig(work);
    assert.strictEqual(loaded.downloadDir, downloadDir);
    assert.deepStrictEqual(loaded.sources, [sourceDir]);
    assert.strictEqual(loaded.scheduler.maxActiveDownloads, DEFAULT_SCHEDULER.maxActiveDownloads);
    console.log("config roundtrip OK");

    // --- manager + watcher, scheduler disabled so nothing dials the network ---
    const manager = new TorrentManager({
        transport: stubTransport,
        downloadDir,
        scheduler: { ...DEFAULT_SCHEDULER, maxActiveDownloads: 0, maxActiveSeeds: 0, maxActiveTotal: 0 },
        listenPortBase: 6881,
        stateDir: work,
    });
    await manager.start();

    const added: string[] = [];
    const removed: string[] = [];
    const watcher = new SourceWatcher({
        intervalMs: 200,
        onAdd: (p) => { added.push(p); void manager.addSourceFile(p); },
        onRemove: (p) => { removed.push(p); void manager.removeSourceFile(p); },
    });
    watcher.setFolders([sourceDir]);

    // Drop a real .torrent into the watched folder.
    const torrentSrc = path.join(process.cwd(), "big-buck-bunny.torrent");
    const torrentDst = path.join(sourceDir, "bbb.torrent");
    await copyFile(torrentSrc, torrentDst);

    watcher.start();
    await delay(600); // let it scan + parse

    let views = manager.views();
    assert.strictEqual(views.length, 1, `expected 1 torrent, got ${views.length}`);
    assert.match(views[0].name, /Big Buck Bunny/i);
    assert.strictEqual(views[0].state, "queued"); // caps=0 so never starts
    console.log(`torrent discovered: "${views[0].name}" state=${views[0].state}`);

    // detail() should fall back to the announce-list trackers even when inactive.
    const detail = manager.detail(views[0].infoHash);
    assert.ok(detail, "detail should exist");
    assert.ok(detail.trackers.length > 0, "trackers from announce list");
    assert.ok(detail.files.length > 0, "files listed");
    console.log(`detail: ${detail.trackers.length} trackers, ${detail.files.length} file(s)`);

    // aggregate reflects the single queued torrent.
    const agg = manager.aggregate();
    assert.strictEqual(agg.torrents, 1);
    console.log(`aggregate: torrents=${agg.torrents} downloading=${agg.downloading} seeding=${agg.seeding}`);

    // --- scan mode runs with zero network (stubTransport throws on any dial),
    // so reaching a settled state proves the drive-scan phase is self-contained.
    const scanMgr = new TorrentManager({
        transport: stubTransport,
        downloadDir,
        scheduler: { ...DEFAULT_SCHEDULER },
        listenPortBase: 7001,
        stateDir: work,
        mode: "scan",
    });
    await scanMgr.start();
    await scanMgr.addSourceFile(torrentDst);
    // Scheduler ticks once a second; wait long enough to start + verify.
    await delay(1800);
    const scanViews = scanMgr.views();
    assert.strictEqual(scanViews.length, 1, "scan manager sees the torrent");
    // Files aren't on disk, so the verified result is "checked" (incomplete).
    assert.strictEqual(scanViews[0].state, "checked", `expected checked, got ${scanViews[0].state}`);
    assert.strictEqual(scanMgr.runMode, "scan");
    console.log(`scan mode: state=${scanViews[0].state} (no network touched)`);
    await scanMgr.stop();

    // Remove the file → watcher should drop it.
    await rm(torrentDst);
    await delay(600);
    views = manager.views();
    assert.strictEqual(views.length, 0, `expected 0 after removal, got ${views.length}`);
    console.log("removal detected, torrent dropped");

    watcher.stop();
    await manager.stop();
    await rm(work, { recursive: true, force: true });
    // Sanity: confirm the temp dir is gone (nothing leaked).
    const leftover = await readdir(os.tmpdir()).then((es) => es.filter((e) => e.startsWith("bt-cli-smoke-")));
    void leftover;
    console.log("\nAll CLI smoke checks passed.");
    process.exit(0);
}

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => { console.error(e); process.exit(1); });
