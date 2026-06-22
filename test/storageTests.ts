import assert from "assert";
import crypto from "crypto";
import os from "os";
import path from "path";
import { mkdtemp, rm, stat, writeFile, utimes, open as fsOpen } from "fs/promises";
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
        // onMismatch forces a full re-hash, bypassing the size+mtime cache (whose
        // own behavior is covered by the dedicated cache tests below) so this case
        // exercises the SHA-1 verifier in isolation.
        const s2 = new Storage(meta, dir);
        await s2.open();
        await s2.writePiece(1, Buffer.alloc(pieceLength, 0x00)); // garbage over piece 1
        const have2 = await s2.verifyExistingPieces(undefined, { onMismatch: () => {} });
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

    // Salvage: an output file already sitting in the save dir but with the wrong
    // total size (here, trailing garbage) used to report 0% because we only read
    // the empty temp copy. Now its still-valid pieces are recognized, imported
    // into the temp copy, and the original output file is left untouched.
    const salvageDir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-salvage-"));
    try {
        const tail = crypto.randomBytes(5000);
        await writeFile(path.join(salvageDir, "blob.bin"), Buffer.concat([data, tail]));

        const s = new Storage(meta, salvageDir);
        await s.open();
        const have = await s.verifyExistingPieces(undefined, { importToTemp: true });
        assert.strictEqual(have.popcount(), meta.pieceHashes.length, "valid pieces salvaged from a mis-sized output file");

        // The salvaged bytes now read back from the in-progress temp copy.
        const salvaged = await s.readBlock(2, 0, 256);
        assert.ok(salvaged.equals(data.subarray(2 * pieceLength, 2 * pieceLength + 256)), "salvaged pieces imported into temp");

        // The original output file must stay exactly as it was until completion.
        const original = await stat(path.join(salvageDir, "blob.bin"));
        assert.strictEqual(original.size, data.length + tail.length, "original output file left untouched");
        await s.close();
    } finally {
        await rm(salvageDir, { recursive: true, force: true });
    }

    // Missing data: when no file backs a torrent on disk, every piece is simply
    // absent, so verify must report zero without reading or hashing anything
    // (the slow path used to hash a zero-filled buffer per piece). A truncated
    // file likewise can't back the pieces past its end.
    const missingDir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-missing-"));
    try {
        const sNone = new Storage(meta, missingDir);
        await sNone.open();
        const none = await sNone.verifyExistingPieces();
        assert.strictEqual(none.popcount(), 0, "no on-disk file → no pieces verify");
        await sNone.close();

        // Only the first piece's worth of bytes exists; the rest is absent.
        await writeFile(path.join(missingDir, "blob.bin"), data.subarray(0, pieceLength));
        const sPart = new Storage(meta, missingDir);
        await sPart.open();
        const part = await sPart.verifyExistingPieces();
        assert.strictEqual(part.popcount(), 1, "only the backed piece verifies");
        assert.ok(part.get(0), "the present piece verifies");
        await sPart.close();
    } finally {
        await rm(missingDir, { recursive: true, force: true });
    }

    // Checked cache: once an unchanged output file has been verified, a repeat
    // verify trusts the cache (size+mtime) instead of re-hashing. We prove this
    // by corrupting the file's bytes while preserving its size and mtime — the
    // cache hit still reports all pieces valid. Then bumping the mtime forces a
    // real re-hash that catches the corruption.
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-cache-"));
    try {
        const file = path.join(cacheDir, "blob.bin");
        await writeFile(file, data);
        // Pin the mtime to a whole second so it round-trips through utimes exactly
        // (sub-millisecond stat precision would otherwise defeat the comparison).
        const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
        await utimes(file, fixed, fixed);

        const s = new Storage(meta, cacheDir);
        await s.open();
        const first = await s.verifyExistingPieces();
        assert.strictEqual(first.popcount(), meta.pieceHashes.length, "fresh verify hashes the full file");
        await s.close();

        // Corrupt the first piece in place, then restore the same mtime.
        const h = await fsOpen(file, "r+");
        await h.write(Buffer.alloc(200, 0xff), 0, 200, 0);
        await h.close();
        await utimes(file, fixed, fixed);

        const s2 = new Storage(meta, cacheDir);
        await s2.open();
        const cached = await s2.verifyExistingPieces();
        assert.strictEqual(cached.popcount(), meta.pieceHashes.length, "unchanged size+mtime → cache hit, no re-hash");
        await s2.close();

        // Bump the mtime: the cache is now stale and a real re-hash runs.
        const later = new Date(fixed.getTime() + 5000);
        await utimes(file, later, later);

        const s3 = new Storage(meta, cacheDir);
        await s3.open();
        const rehashed = await s3.verifyExistingPieces();
        assert.ok(!rehashed.get(0), "changed mtime invalidates the cache and the corrupt piece is caught");
        assert.ok(rehashed.get(1) && rehashed.get(2), "intact pieces still verify after re-hash");
        await s3.close();
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }

    // Temp-file cache: a partial download lives only in the temp copy (no output
    // file yet), and a scan must trust that copy's verified pieces from the cache
    // instead of re-hashing it every startup. Proven the same way as the output
    // cache — corrupt the temp bytes while preserving size+mtime and the cache
    // hit still reports the pieces valid; bumping the mtime forces a real re-hash.
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-temp-"));
    try {
        const all = meta.pieceHashes.map((_, i) => i);
        const infoHashHex = meta.infoHash.toString("hex");
        const tempPath = path.join(tempDir, ".bittorrent-incomplete", infoHashHex, "blob.bin");

        // A prior session downloads every piece into the temp copy and exits
        // without finalizing (no output file is produced).
        const writer = new Storage(meta, tempDir, new Set(all));
        await writer.open();
        for (let i = 0; i < meta.pieceHashes.length; i++) {
            const piece = data.subarray(i * pieceLength, Math.min((i + 1) * pieceLength, data.length));
            await writer.writePiece(i, piece);
        }
        await writer.close();

        // No output file ever appeared; the data is purely in the temp copy.
        const noOutput = await stat(path.join(tempDir, "blob.bin")).catch(() => undefined);
        assert.ok(!noOutput, "partial download leaves no output file");
        const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
        await utimes(tempPath, fixed, fixed);

        // First scan hashes the temp copy and records its size+mtime in the cache.
        const ts1 = new Storage(meta, tempDir, new Set(all));
        await ts1.open();
        assert.strictEqual((await ts1.verifyExistingPieces()).popcount(), meta.pieceHashes.length, "temp copy fully verifies");
        await ts1.close();

        // Corrupt the temp copy in place but keep its size+mtime.
        const th = await fsOpen(tempPath, "r+");
        await th.write(Buffer.alloc(200, 0xff), 0, 200, 0);
        await th.close();
        await utimes(tempPath, fixed, fixed);

        const ts2 = new Storage(meta, tempDir, new Set(all));
        await ts2.open();
        const cached = await ts2.verifyExistingPieces();
        assert.strictEqual(cached.popcount(), meta.pieceHashes.length, "unchanged temp size+mtime → cache hit, no re-hash");
        await ts2.close();

        // Bump the temp copy's mtime: the cache is stale and a re-hash runs.
        const later = new Date(fixed.getTime() + 5000);
        await utimes(tempPath, later, later);
        const ts3 = new Storage(meta, tempDir, new Set(all));
        await ts3.open();
        const rehashed = await ts3.verifyExistingPieces();
        assert.ok(!rehashed.get(0), "changed temp mtime invalidates the cache and the corrupt piece is caught");
        assert.ok(rehashed.get(1) && rehashed.get(2), "intact temp pieces still verify after re-hash");
        await ts3.close();
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }

    // Per-file cache granularity: when one file in a multi-file torrent changes,
    // only that file's pieces re-hash; an unchanged file's pieces stay trusted
    // from the cache (proven by secretly corrupting the unchanged file's bytes
    // while keeping its size+mtime — those pieces still report valid because they
    // were never re-read).
    const multiDir = await mkdtemp(path.join(os.tmpdir(), "bt-storage-multi-"));
    try {
        const fileLen = pieceLength * 2;
        const dataA = crypto.randomBytes(fileLen);
        const dataB = crypto.randomBytes(fileLen);
        const full = Buffer.concat([dataA, dataB]);
        const pieceHashes: Buffer[] = [];
        for (let i = 0; i < 4; i++) {
            pieceHashes.push(crypto.createHash("sha1").update(full.subarray(i * pieceLength, (i + 1) * pieceLength)).digest());
        }
        const multiMeta: TorrentMeta = {
            infoHash: Buffer.alloc(20, 7),
            name: "multi",
            pieceLength,
            pieceHashes,
            files: [
                { path: ["a.bin"], length: fileLen, offsetInTorrent: 0 },
                { path: ["b.bin"], length: fileLen, offsetInTorrent: fileLen },
            ],
            totalLength: fileLen * 2,
            isPrivate: false,
            announceList: [],
        };
        const aPath = path.join(multiDir, "a.bin");
        const bPath = path.join(multiDir, "b.bin");
        await writeFile(aPath, dataA);
        await writeFile(bPath, dataB);
        const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
        await utimes(aPath, fixed, fixed);
        await utimes(bPath, fixed, fixed);

        const sm1 = new Storage(multiMeta, multiDir);
        await sm1.open();
        assert.strictEqual((await sm1.verifyExistingPieces()).popcount(), 4, "all four pieces verify and cache");
        await sm1.close();

        // Corrupt a.bin in place but keep its size+mtime → its pieces (0,1) must
        // stay trusted. Corrupt b.bin AND bump its mtime → its pieces (2,3) must
        // re-hash and fail.
        const ha = await fsOpen(aPath, "r+");
        await ha.write(Buffer.alloc(300, 0xff), 0, 300, 0);
        await ha.close();
        await utimes(aPath, fixed, fixed);

        const hb = await fsOpen(bPath, "r+");
        await hb.write(Buffer.alloc(300, 0xff), 0, 300, 0);
        await hb.close();
        const later = new Date(fixed.getTime() + 5000);
        await utimes(bPath, later, later);

        const sm2 = new Storage(multiMeta, multiDir);
        await sm2.open();
        const got = await sm2.verifyExistingPieces();
        assert.ok(got.get(0) && got.get(1), "unchanged file's pieces trusted from cache despite corruption (not re-hashed)");
        assert.ok(!got.get(2), "changed file re-hashed: its corrupt first piece is caught");
        assert.ok(got.get(3), "changed file re-hashed: its intact second piece still verifies");
        await sm2.close();
    } finally {
        await rm(multiDir, { recursive: true, force: true });
    }

    console.log("Storage tests passed.");
}
