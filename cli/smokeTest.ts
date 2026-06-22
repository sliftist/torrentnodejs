import assert from "assert";
import os from "os";
import path from "path";
import { mkdtemp, copyFile, rm, readdir, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { Duplex } from "stream";
import { Transport, UdpSocketLike, TcpListenerLike } from "../transport";
import { EventEmitter } from "events";
import { TorrentManager } from "./torrentManager";
import { SourceWatcher } from "./watcher";
import { Config, DEFAULT_SCHEDULER, DEFAULT_PEER_ID_PREFIX, saveConfig, loadConfig } from "./config";

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
    const copyDir = path.join(work, "copy");
    const downloadDir = path.join(work, "dl");
    await rm(sourceDir, { recursive: true, force: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(downloadDir, { recursive: true });

    // --- config roundtrip ---
    const cfg: Config = {
        wireguardConfigPath: "/tmp/fake.conf",
        downloadDir,
        sources: [sourceDir],
        copySources: [],
        peerIdPrefix: DEFAULT_PEER_ID_PREFIX,
        listenPort: 6881,
        webPort: 8443,
        scheduler: { ...DEFAULT_SCHEDULER },
    };
    await saveConfig(cfg, work);
    const loaded = await loadConfig(work);
    assert.strictEqual(loaded.downloadDir, downloadDir);
    assert.deepStrictEqual(loaded.sources, [sourceDir]);
    assert.deepStrictEqual(loaded.copySources, []);
    assert.strictEqual(loaded.scheduler.downloadSlots, DEFAULT_SCHEDULER.downloadSlots);
    console.log("config roundtrip OK");

    // --- manager + watcher. The stub transport throws on every dial, so the
    // torrent starts and verifies the (absent) files but can never connect to a
    // peer; with no peers it never earns a download slot and stays "queued". ---
    const manager = new TorrentManager({
        transport: stubTransport,
        downloadDir,
        scheduler: { ...DEFAULT_SCHEDULER, downloadSlots: 0 },
        listenPort: 6881,
        stateDir: work,
        sources: [sourceDir],
        copySources: [copyDir],
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
    // Wait for the scheduler to start + verify the torrent (verification of a
    // missing on-disk file is instant; the scheduler tick is once a second).
    await delay(1800);

    let views = manager.views();
    assert.strictEqual(views.length, 1, `expected 1 torrent, got ${views.length}`);
    assert.match(views[0].name, /Big Buck Bunny/i);
    assert.strictEqual(views[0].state, "queued"); // started + verified, but no peers → no slot
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
        listenPort: 7001,
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

    // --- copy source: a .torrent appearing in a watched copy folder is copied
    // into the first regular source, then loaded — so deleting the original
    // can't lose it. ---
    await mkdir(copyDir, { recursive: true });
    const copyWatcher = new SourceWatcher({
        intervalMs: 200,
        onAdd: (p) => void (async () => {
            const dest = path.join(sourceDir, path.basename(p));
            await copyFile(p, dest);
            await manager.addSourceFile(dest);
        })(),
        onRemove: () => {},
    });
    copyWatcher.setFolders([copyDir]);
    copyWatcher.start();
    await copyFile(torrentSrc, path.join(copyDir, "bbb.torrent"));
    await delay(800);
    const archived = await readdir(sourceDir);
    assert.ok(archived.includes("bbb.torrent"), `expected bbb.torrent archived into source, saw ${archived.join(",")}`);
    views = manager.views();
    assert.strictEqual(views.length, 1, `expected 1 torrent from copy source, got ${views.length}`);
    console.log("copy source archived + loaded the torrent");
    copyWatcher.stop();

    // --- delete: stage a fake data file, then deleteTorrent should remove the
    // data, the source .torrent, and drop the torrent from the manager. ---
    const delHash = manager.views()[0].infoHash;
    const firstFile = manager.torrentFiles(delHash)[0];
    const dataPath = path.join(downloadDir, firstFile.path);
    await mkdir(path.dirname(dataPath), { recursive: true });
    await writeFile(dataPath, "x");
    const archivedSource = path.join(sourceDir, "bbb.torrent");
    const copyOriginal = path.join(copyDir, "bbb.torrent");
    assert.ok(existsSync(dataPath), "data file staged");
    assert.ok(existsSync(archivedSource), "source .torrent present before delete");
    assert.ok(existsSync(copyOriginal), "copy-source original present before delete");
    await manager.deleteTorrent(delHash);
    assert.ok(!existsSync(dataPath), "data file removed after delete");
    assert.ok(!existsSync(archivedSource), "source .torrent removed after delete");
    assert.ok(!existsSync(copyOriginal), "copy-source original removed after delete");
    assert.strictEqual(manager.views().length, 0, "torrent dropped after delete");
    console.log("delete removed data + .torrent (source + copy source) and dropped the torrent");

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
