// Download a small partial range of Big Buck Bunny — the first 4 pieces (1 MB)
// — through the public BBB swarm. Verifies SHA-1 and writes to ./downloads/.
import path from "path";
import { BitTorrentClient } from "../index";

async function main() {
    const torrentPath = process.argv[2] || path.join(__dirname, "..", "big-buck-bunny.torrent");
    const saveDir = process.argv[3] || path.join(__dirname, "..", "downloads");

    const client = new BitTorrentClient();
    const torrent = await client.addTorrentFile(torrentPath, {
        saveDir,
        selection: { pieceRange: { from: 0, toExclusive: 4 } },  // first 4 pieces (~1 MB)
    });

    console.log(`Downloading ${torrent.meta.name}`);
    console.log(`  info_hash       : ${torrent.meta.infoHash.toString("hex")}`);
    console.log(`  selected pieces : ${[...torrent.pieceManager.selected].sort((a,b) => a-b).join(", ")}`);
    console.log(`  selected bytes  : ${torrent.totalSelectedBytes}`);
    console.log(`  save dir        : ${saveDir}\n`);

    torrent.on("peer-connect", (p: { ip: string; port: number; peerId: string }) => {
        console.log(`  + peer ${p.ip}:${p.port}`);
    });
    torrent.on("piece", (i: number) => {
        const pct = (torrent.progress * 100).toFixed(1);
        console.log(`  ✓ piece ${i} (${torrent.downloadedBytes}/${torrent.totalSelectedBytes} bytes, ${pct}%)`);
    });
    torrent.on("tracker-error", (e: { url: string; error: Error }) => {
        console.log(`  [tracker] ${e.url} → ${e.error.message}`);
    });

    const TIMEOUT_MS = 120_000;
    const result = await Promise.race([
        torrent.complete().then(() => "done"),
        new Promise((r) => setTimeout(() => r("timeout"), TIMEOUT_MS)),
    ]);

    if (result === "done") {
        console.log(`\n✅ Downloaded ${torrent.downloadedBytes} bytes in ${((Date.now() - (torrent as unknown as { startedAt: number }).startedAt) / 1000).toFixed(1)}s`);
    } else {
        console.log(`\n⚠ Timed out after ${TIMEOUT_MS / 1000}s. Got ${torrent.downloadedBytes}/${torrent.totalSelectedBytes} bytes (${(torrent.progress * 100).toFixed(1)}%) from ${torrent.peers.length} peers.`);
    }
    await torrent.stop();
    await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
