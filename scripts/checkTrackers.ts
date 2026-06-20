// Re-announce as a fresh peer to every tracker on the seed and see whether
// they actually have us listed (and whether they respond at all).
import crypto from "crypto";
import { NodeTransport, announceUdp, announceHttp } from "../index";

const INFO_HASH = process.argv[2] || "1500574983e229204c70ea02bc28c8759916e749";
const TRACKERS = [
    "udp://tracker.empire-js.us:1337",
    "udp://tracker.opentrackr.org:1337",
    "udp://open.demonii.com:1337",
    "udp://tracker.torrent.eu.org:451",
    "udp://exodus.desync.com:6969",
];
const OUR_PUBLIC = "65.109.93.113";
const OUR_PORT = 6881;

async function main() {
    const transport = new NodeTransport();
    const peerId = Buffer.concat([Buffer.from("-CK0001-"), crypto.randomBytes(12)]);
    const infoHash = Buffer.from(INFO_HASH, "hex");

    for (const url of TRACKERS) {
        process.stdout.write(`${url.padEnd(45)}: `);
        try {
            const announce = url.startsWith("udp://") ? announceUdp : announceHttp;
            const t0 = Date.now();
            const res = await announce(transport, url, {
                infoHash, peerId, port: 12345,
                uploaded: 0, downloaded: 0, left: 8 * 1024 * 1024,
                numWant: 50,
                event: "started",
            });
            const elapsed = Date.now() - t0;
            const usListed = res.peers.some(p => p.ip === OUR_PUBLIC && p.port === OUR_PORT);
            const seedersCount = res.seeders ?? "?";
            const leechersCount = res.leechers ?? "?";
            const peerSample = res.peers.slice(0, 5).map(p => `${p.ip}:${p.port}`).join(", ");
            console.log(`${elapsed}ms — seeders=${seedersCount} leechers=${leechersCount} peers=${res.peers.length}${usListed ? " ✓us-listed" : " ✗us-NOT-listed"}`);
            if (res.peers.length > 0) console.log(`  sample: ${peerSample}`);
        } catch (e) {
            console.log(`FAIL — ${(e as Error).message}`);
        }
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
