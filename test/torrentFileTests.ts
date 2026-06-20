import assert from "assert";
import path from "path";
import { parseTorrentFile, pieceLengthAt } from "../torrentFile";

export async function runTorrentFileTests() {
    const bbbPath = path.join(__dirname, "..", "big-buck-bunny.torrent");
    const meta = await parseTorrentFile(bbbPath);

    assert.ok(meta.name.toLowerCase().includes("buck"), `name should mention buck, was "${meta.name}"`);
    assert.strictEqual(meta.infoHash.length, 20);
    assert.ok(meta.pieceLength > 0 && (meta.pieceLength & (meta.pieceLength - 1)) === 0,
        `pieceLength should be a power of two, was ${meta.pieceLength}`);
    assert.ok(meta.pieceHashes.length > 0, "must have pieces");
    assert.ok(meta.files.length > 0, "must have files");
    assert.strictEqual(meta.files.reduce((a, f) => a + f.length, 0), meta.totalLength);

    // Each piece hash is 20 bytes
    for (const h of meta.pieceHashes) assert.strictEqual(h.length, 20);

    // Last piece is <= pieceLength
    const last = pieceLengthAt(meta, meta.pieceHashes.length - 1);
    assert.ok(last > 0 && last <= meta.pieceLength);

    // At least one tracker
    const allTrackers = meta.announceList.flat();
    assert.ok(allTrackers.length > 0, "must have at least one tracker");

    console.log(`Torrent file tests passed (name="${meta.name}", info_hash=${meta.infoHash.toString("hex")}).`);
}
