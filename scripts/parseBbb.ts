import path from "path";
import { parseTorrentFile, pieceLengthAt } from "../torrentFile";

async function main() {
    const torrentPath = process.argv[2] || path.join(__dirname, "..", "big-buck-bunny.torrent");
    const meta = await parseTorrentFile(torrentPath);
    console.log(`Torrent: ${torrentPath}`);
    console.log(`  name        : ${meta.name}`);
    console.log(`  info_hash   : ${meta.infoHash.toString("hex")}`);
    console.log(`  pieceLength : ${meta.pieceLength} bytes (${(meta.pieceLength / 1024).toFixed(0)} KiB)`);
    console.log(`  pieces      : ${meta.pieceHashes.length} (last is ${pieceLengthAt(meta, meta.pieceHashes.length - 1)} bytes)`);
    console.log(`  totalLength : ${meta.totalLength} bytes (${(meta.totalLength / (1024 * 1024)).toFixed(2)} MiB)`);
    console.log(`  files       : ${meta.files.length}`);
    for (const f of meta.files) {
        console.log(`    ${f.path.join("/").padEnd(50)} ${f.length.toString().padStart(12)} bytes`);
    }
    console.log(`  trackers    : ${meta.announceList.length} tier(s)`);
    for (const tier of meta.announceList) {
        for (const url of tier) console.log(`    ${url}`);
    }
    if (meta.createdBy)    console.log(`  created by  : ${meta.createdBy}`);
    if (meta.creationDate) console.log(`  created at  : ${new Date(meta.creationDate * 1000).toISOString()}`);
    if (meta.comment)      console.log(`  comment     : ${meta.comment}`);
    if (meta.urlList)      console.log(`  webseeds    : ${meta.urlList.join(", ")}`);
    console.log(`  magnet      : magnet:?xt=urn:btih:${meta.infoHash.toString("hex")}&dn=${encodeURIComponent(meta.name)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
