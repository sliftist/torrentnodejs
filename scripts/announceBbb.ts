import path from "path";
import crypto from "crypto";
import { parseTorrentFile } from "../torrentFile";
import { NodeTransport } from "../transport";
import { TrackerPool } from "../trackerPool";

const WAIT_MS = 15_000;

async function main() {
    const torrentPath = process.argv[2] || path.join(__dirname, "..", "big-buck-bunny.torrent");
    const meta = await parseTorrentFile(torrentPath);
    console.log(`Announcing ${meta.name} (info_hash=${meta.infoHash.toString("hex")})`);
    const allTrackers = meta.announceList.flat();
    const supported = allTrackers.filter((u) => u.startsWith("udp://") || u.startsWith("http://") || u.startsWith("https://"));
    console.log(`Supported trackers: ${supported.length} / ${allTrackers.length}\n`);

    const transport = new NodeTransport();
    const peerId = Buffer.concat([Buffer.from("-BT0001-"), crypto.randomBytes(12)]);

    const pool = new TrackerPool({
        transport,
        trackers: meta.announceList,
        params: () => ({
            infoHash: meta.infoHash,
            peerId,
            port: 6881,
            uploaded: 0,
            downloaded: 0,
            left: meta.totalLength,
            numWant: 100,
        }),
    });

    pool.on("peer", (p) => console.log(`  + ${p.ip.padEnd(15)}:${p.port}`));
    pool.on("announce", (r: { url: string; interval: number; peers: { ip: string; port: number }[]; seeders?: number; leechers?: number }) => {
        console.log(`[${r.url}] interval=${r.interval}s peers=${r.peers.length} seeders=${r.seeders ?? "?"} leechers=${r.leechers ?? "?"}`);
    });
    pool.on("tracker-error", (e: { url: string; error: Error }) => {
        console.log(`[${e.url}] FAIL ${e.error.message}`);
    });

    pool.start();
    await new Promise((r) => setTimeout(r, WAIT_MS));
    console.log(`\nUnique peers after ${WAIT_MS / 1000}s: ${pool.peers.length}`);
    await pool.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
