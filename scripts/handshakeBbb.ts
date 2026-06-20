// Pick one peer from a tracker announce, handshake with it, log its bitfield.
import path from "path";
import crypto from "crypto";
import { parseTorrentFile } from "../torrentFile";
import { NodeTransport } from "../transport";
import { TrackerPool } from "../trackerPool";
import { PeerConnection } from "../peerConnection";

const PEER_WAIT_MS = 10_000;

async function main() {
    const torrentPath = process.argv[2] || path.join(__dirname, "..", "big-buck-bunny.torrent");
    const meta = await parseTorrentFile(torrentPath);
    const transport = new NodeTransport();
    const peerId = Buffer.concat([Buffer.from("-BT0001-"), crypto.randomBytes(12)]);

    const pool = new TrackerPool({
        transport,
        trackers: meta.announceList,
        params: () => ({
            infoHash: meta.infoHash, peerId, port: 6881,
            uploaded: 0, downloaded: 0, left: meta.totalLength,
            numWant: 50,
        }),
    });
    pool.on("announce", (r: { url: string; peers: unknown[]; interval: number }) => {
        console.log(`  [announce] ${r.url} → ${r.peers.length} peers, interval=${r.interval}s`);
    });
    pool.on("tracker-error", (e: { url: string; error: Error }) => {
        console.log(`  [tracker-error] ${e.url}: ${e.error.message}`);
    });
    pool.start();
    console.log(`Announcing… waiting up to ${PEER_WAIT_MS / 1000}s for peers`);
    await new Promise((r) => setTimeout(r, PEER_WAIT_MS));
    await pool.stop();

    const peers = pool.peers;
    if (peers.length === 0) { console.error("No peers — try again later"); process.exit(1); }
    console.log(`Got ${peers.length} peers. Trying handshakes until one succeeds...`);

    for (const peer of peers) {
        const conn = new PeerConnection({
            transport,
            host: peer.ip,
            port: peer.port,
            infoHash: meta.infoHash,
            peerId,
            numPieces: meta.pieceHashes.length,
        });
        conn.on("error", () => { /* ignore — try next */ });
        try {
            await conn.connect();
        } catch (e) {
            console.log(`  ✗ ${peer.ip}:${peer.port} (${(e as Error).message})`);
            continue;
        }
        console.log(`  ✓ handshake with ${peer.ip}:${peer.port}`);
        console.log(`     remote peer_id: ${conn.remotePeerId.toString("hex")}`);

        // Wait briefly for bitfield/have messages
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, 3_000);
            conn.once("bitfield", () => { clearTimeout(timer); resolve(undefined); });
        });

        const has = conn.peerBitfield.popcount();
        console.log(`     peer has ${has}/${meta.pieceHashes.length} pieces (${((has / meta.pieceHashes.length) * 100).toFixed(1)}%)`);
        conn.destroy();
        return;
    }
    console.log("All peers failed to handshake.");
    process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
