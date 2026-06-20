// Loopback test: in one process, run a seeder for a freshly-generated
// random-data torrent and a downloader. The downloader is told about the
// seeder directly via extraPeers (no tracker needed). Verifies that the
// downloaded bytes equal the originals.
import path from "path";
import os from "os";
import crypto from "crypto";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { BitTorrentClient, createTorrentFromData } from "../index";

const DATA_BYTES = 2 * 1024 * 1024;      // 2 MB
const PIECE_LENGTH = 256 * 1024;          // 256 KiB → 8 pieces

async function main() {
    const tmpRoot = path.join(os.tmpdir(), "bt-loop-" + Date.now());
    const seedDir = path.join(tmpRoot, "seed");
    const dlDir = path.join(tmpRoot, "download");
    await mkdir(seedDir, { recursive: true });
    await mkdir(dlDir, { recursive: true });

    // Generate random data + .torrent
    const data = crypto.randomBytes(DATA_BYTES);
    const dataName = "random.bin";
    await writeFile(path.join(seedDir, dataName), data);
    const { meta } = createTorrentFromData(data, {
        name: dataName,
        pieceLength: PIECE_LENGTH,
        createdBy: "bittorrent-loop-test",
        creationDate: Math.floor(Date.now() / 1000),
    });
    console.log(`Created torrent ${meta.name} (${meta.totalLength} bytes, ${meta.pieceHashes.length} pieces)`);
    console.log(`  info_hash: ${meta.infoHash.toString("hex")}\n`);

    // Seeder
    const seeder = new BitTorrentClient();
    const seedTorrent = await seeder.addTorrentMeta(meta, {
        saveDir: seedDir,
        seedExisting: true,
        listenPort: 0,
    });
    const port = seedTorrent.listenPort;
    if (!port) throw new Error("Seeder didn't bind a port");
    console.log(`Seeder listening on 127.0.0.1:${port}`);
    seedTorrent.on("peer-connect", (p: { ip: string; port: number }) =>
        console.log(`  seeder ← peer ${p.ip}:${p.port}`));
    seedTorrent.on("uploaded", (u: { bytes: number }) =>
        console.log(`  seeder ↑ ${u.bytes} bytes`));

    // Downloader — point straight at our seeder
    const downloader = new BitTorrentClient();
    const dlTorrent = await downloader.addTorrentMeta(meta, {
        saveDir: dlDir,
        extraPeers: [{ ip: "127.0.0.1", port }],
    });
    dlTorrent.on("piece", (i: number) => {
        const pct = (dlTorrent.progress * 100).toFixed(1);
        console.log(`  downloader ✓ piece ${i} (${pct}%)`);
    });

    const t0 = Date.now();
    await dlTorrent.complete();
    const elapsedMs = Date.now() - t0;
    console.log(`\nDownload complete in ${elapsedMs}ms`);

    // Verify byte-for-byte
    const downloaded = await readFile(path.join(dlDir, dataName));
    const equal = downloaded.equals(data);
    console.log(`Bytes match original: ${equal}`);

    await dlTorrent.stop();
    await seedTorrent.stop();
    await downloader.close();
    await seeder.close();
    await rm(tmpRoot, { recursive: true, force: true });

    if (!equal) throw new Error("Downloaded bytes don't match originals");
    console.log("Seed/download loop test passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
