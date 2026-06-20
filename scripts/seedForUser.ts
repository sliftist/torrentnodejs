// Long-running seeder: generate a random-data file, build a .torrent for it,
// announce to public trackers, and serve the data to anyone who asks.
// Prints all the info the user needs to start downloading from us.
import path from "path";
import os from "os";
import crypto from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { BitTorrentClient, createTorrentFromData, magnetUri } from "../index";

const DATA_BYTES = 8 * 1024 * 1024;       // 8 MiB
const PIECE_LENGTH = 256 * 1024;           // 256 KiB
const LISTEN_PORT = 6881;                   // BT default

const TRACKERS = [
    "udp://tracker.empire-js.us:1337",
    "udp://tracker.opentrackr.org:1337",
    "udp://open.demonii.com:1337",
    "udp://tracker.torrent.eu.org:451",
    "udp://exodus.desync.com:6969",
];

async function getPublicIp(): Promise<string | undefined> {
    try {
        const res = await fetch("https://api.ipify.org");
        return (await res.text()).trim();
    } catch {
        return undefined;
    }
}

async function main() {
    const outDir = process.argv[2] || path.join(os.tmpdir(), "bt-seed");
    await mkdir(outDir, { recursive: true });

    const dataName = `random-${Date.now()}.bin`;
    const dataPath = path.join(outDir, dataName);
    const torrentPath = path.join(outDir, `${dataName}.torrent`);

    console.log(`Generating ${(DATA_BYTES / (1024 * 1024)).toFixed(0)} MiB of random data → ${dataPath}`);
    const data = crypto.randomBytes(DATA_BYTES);
    await writeFile(dataPath, data);

    const { buffer, meta } = createTorrentFromData(data, {
        name: dataName,
        pieceLength: PIECE_LENGTH,
        announce: TRACKERS[0],
        announceList: TRACKERS.map((t) => [t]),
        createdBy: "bittorrent-node-seed",
        creationDate: Math.floor(Date.now() / 1000),
    });
    await writeFile(torrentPath, buffer);
    console.log(`Wrote .torrent → ${torrentPath}`);

    const client = new BitTorrentClient();
    const torrent = await client.addTorrentMeta(meta, {
        saveDir: outDir,
        seedExisting: true,
        listenPort: LISTEN_PORT,
    });

    const publicIp = await getPublicIp();
    const port = torrent.listenPort;

    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  SEEDING                                                                          ║`);
    console.log(`╠══════════════════════════════════════════════════════════════════════════════════╣`);
    console.log(`║  name           : ${meta.name.padEnd(64)}║`);
    console.log(`║  size           : ${`${meta.totalLength} bytes (${(meta.totalLength / (1024 * 1024)).toFixed(2)} MiB)`.padEnd(64)}║`);
    console.log(`║  pieces         : ${`${meta.pieceHashes.length} × ${meta.pieceLength}`.padEnd(64)}║`);
    console.log(`║  info_hash      : ${meta.infoHash.toString("hex").padEnd(64)}║`);
    console.log(`║  listen port    : ${String(port).padEnd(64)}║`);
    console.log(`║  public address : ${`${publicIp || "?"}:${port}`.padEnd(64)}║`);
    console.log(`║  .torrent file  : ${torrentPath.padEnd(64)}║`);
    console.log(`╚══════════════════════════════════════════════════════════════════════════════════╝`);
    console.log(`\nMagnet URI (paste into any BitTorrent client):`);
    console.log(`  ${magnetUri(meta)}\n`);
    console.log(`Public trackers we're announcing to:`);
    for (const t of TRACKERS) console.log(`  ${t}`);
    if (publicIp) {
        console.log(`\nIf no tracker connects, add us manually as a peer: ${publicIp}:${port}`);
    }
    console.log(`\nSeeding indefinitely. Press Ctrl-C to stop.\n`);

    torrent.on("peer-connect", (p: { ip: string; port: number; peerId: string }) =>
        console.log(`[${new Date().toISOString()}] + peer ${p.ip}:${p.port} (${p.peerId.slice(0, 16)}…)`));
    torrent.on("peer-disconnect", (p: { ip: string; port: number }) =>
        console.log(`[${new Date().toISOString()}] - peer ${p.ip}:${p.port}`));
    let cumulativeUp = 0;
    torrent.on("uploaded", (u: { bytes: number; peerId: string }) => {
        cumulativeUp += u.bytes;
    });
    setInterval(() => {
        console.log(`[${new Date().toISOString()}] stats: peers=${torrent.peers.length} uploaded=${(cumulativeUp / (1024 * 1024)).toFixed(2)} MiB`);
    }, 30_000).unref();
    torrent.on("tracker-error", (e: { url: string; error: Error }) =>
        console.log(`[${new Date().toISOString()}] tracker ${e.url}: ${e.error.message}`));

    // Don't exit
    await new Promise(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
