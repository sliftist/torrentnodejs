import assert from "assert";
import crypto from "crypto";
import os from "os";
import path from "path";
import { mkdtemp, rm, stat } from "fs/promises";
import { Storage } from "../storage";
import { Bitfield } from "../bitfield";
import { TorrentMeta } from "../torrentFile";

function makeMetaFromData(data: Buffer, pieceLength: number): TorrentMeta {
    const numPieces = Math.ceil(data.length / pieceLength);
    const pieceHashes: Buffer[] = [];
    for (let i = 0; i < numPieces; i++) {
        const piece = data.subarray(i * pieceLength, Math.min((i + 1) * pieceLength, data.length));
        pieceHashes.push(crypto.createHash("sha1").update(piece).digest());
    }
    return {
        infoHash: Buffer.alloc(20),
        name: "blob.bin",
        pieceLength,
        pieceHashes,
        files: [{ path: ["blob.bin"], length: data.length, offsetInTorrent: 0 }],
        totalLength: data.length,
        isPrivate: false,
        announceList: [],
    };
}

export async function runStorageTests() {
    const pieceLength = 32 * 1024;
    const data = crypto.randomBytes(pieceLength * 3 + 777); // 4 pieces, last short
    const meta = makeMetaFromData(data, pieceLength);

    const dir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-"));
    try {
        // Write all pieces, then verify they all check out.
        const s1 = new Storage(meta, dir);
        await s1.open();
        for (let i = 0; i < meta.pieceHashes.length; i++) {
            const piece = data.subarray(i * pieceLength, Math.min((i + 1) * pieceLength, data.length));
            await s1.writePiece(i, piece);
        }
        const have = await s1.verifyExistingPieces();
        assert.strictEqual(have.popcount(), meta.pieceHashes.length, "all pieces should verify");
        // readBlock round-trips
        const block = await s1.readBlock(0, 100, 256);
        assert.ok(block.equals(data.subarray(100, 356)));
        await s1.close();

        // Re-open: corrupt one piece on disk and confirm it fails verification.
        const s2 = new Storage(meta, dir);
        await s2.open();
        await s2.writePiece(1, Buffer.alloc(pieceLength, 0x00)); // garbage over piece 1
        const have2 = await s2.verifyExistingPieces();
        assert.ok(!have2.get(1), "corrupted piece 1 must not verify");
        assert.ok(have2.get(0) && have2.get(2) && have2.get(3), "intact pieces still verify");
        await s2.close();

        // While in progress, nothing should sit in the save dir yet — the file
        // lives in the temp dir until it's complete.
        const preFinal = await stat(path.join(dir, "blob.bin")).catch(() => undefined);
        assert.ok(!preFinal, "incomplete file must not appear in the save dir");

        // Re-write every piece correctly, finalize, and confirm the file is
        // renamed into the save dir and still reads back.
        const s3 = new Storage(meta, dir);
        await s3.open();
        for (let i = 0; i < meta.pieceHashes.length; i++) {
            const piece = data.subarray(i * pieceLength, Math.min((i + 1) * pieceLength, data.length));
            await s3.writePiece(i, piece);
        }
        const complete = new Bitfield(meta.pieceHashes.length);
        for (let i = 0; i < meta.pieceHashes.length; i++) complete.set(i);
        await s3.finalizeFiles(complete);
        const finalStat = await stat(path.join(dir, "blob.bin"));
        assert.strictEqual(finalStat.size, data.length, "finalized file is full size in the save dir");
        const postBlock = await s3.readBlock(0, 100, 256);
        assert.ok(postBlock.equals(data.subarray(100, 356)), "reads work after finalize");
        await s3.close();

        // A fresh Storage sees the finished file as complete with no temp dir.
        const s4 = new Storage(meta, dir);
        await s4.open();
        const have4 = await s4.verifyExistingPieces();
        assert.strictEqual(have4.popcount(), meta.pieceHashes.length, "finalized file verifies on reopen");
        await s4.close();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }

    console.log("Storage tests passed.");
}
