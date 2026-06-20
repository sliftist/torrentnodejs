import assert from "assert";
import crypto from "crypto";
import { Bitfield } from "../bitfield";
import { PieceManager, BLOCK_SIZE } from "../pieceManager";
import { TorrentMeta } from "../torrentFile";

function makeMeta(numPieces: number, pieceLength: number, lastPieceLength?: number): TorrentMeta {
    const total = pieceLength * (numPieces - 1) + (lastPieceLength ?? pieceLength);
    return {
        infoHash: Buffer.alloc(20),
        name: "test",
        pieceLength,
        pieceHashes: Array.from({ length: numPieces }, () => Buffer.alloc(20)),
        files: [{ path: ["test"], length: total, offsetInTorrent: 0 }],
        totalLength: total,
        isPrivate: false,
        announceList: [],
    };
}

export async function runPieceManagerTests() {
    // Selection: pieceRange
    const meta = makeMeta(10, 256 * 1024);
    const pm1 = new PieceManager(meta, { pieceRange: { from: 2, toExclusive: 5 } });
    assert.deepStrictEqual([...pm1.selected].sort((a, b) => a - b), [2, 3, 4]);

    // Selection: byteRange that straddles piece boundaries
    const pm2 = new PieceManager(meta, { byteRange: { start: 100, endExclusive: 256 * 1024 + 10 } });
    assert.deepStrictEqual([...pm2.selected].sort((a, b) => a - b), [0, 1]);

    // Selection: full default
    const pm3 = new PieceManager(meta);
    assert.strictEqual(pm3.selected.size, 10);

    // End-to-end SHA-1 verify
    const payload = crypto.randomBytes(256 * 1024);
    const hash = crypto.createHash("sha1").update(payload).digest();
    const metaWithHash: TorrentMeta = { ...meta, pieceHashes: [hash, ...meta.pieceHashes.slice(1)] };
    const pm = new PieceManager(metaWithHash, { pieceRange: { from: 0, toExclusive: 1 } });

    // Peer A has piece 0
    const peerA = new Bitfield(10);
    peerA.set(0);
    pm.addPeer("A", peerA);

    let received: number | undefined;
    pm.on("piece-complete", (i) => { received = i; });

    const numBlocks = Math.ceil((256 * 1024) / BLOCK_SIZE);
    for (let b = 0; b < numBlocks; b++) {
        const req = pm.pickBlock("A");
        assert.ok(req, `pickBlock should return for block ${b}`);
        assert.strictEqual(req.pieceIndex, 0);
        pm.markInflight(req, "A");
        const blockData = payload.subarray(req.begin, req.begin + req.length);
        const result = pm.addBlock(req, blockData, "A");
        if (b === numBlocks - 1) {
            assert.strictEqual(result.kind, "complete");
            assert.ok((result as { kind: "complete"; piece: Buffer }).piece.equals(payload));
        } else {
            assert.strictEqual(result.kind, "stored");
        }
    }
    assert.strictEqual(received, 0);
    assert.ok(pm.haveBitfield.get(0));
    assert.ok(pm.isComplete());

    // Wrong SHA-1: piece is reset and we should be able to retry
    const pmBad = new PieceManager(metaWithHash, { pieceRange: { from: 0, toExclusive: 1 } });
    pmBad.addPeer("A", peerA);
    for (let b = 0; b < numBlocks; b++) {
        const req = pmBad.pickBlock("A");
        if (!req) break;
        pmBad.markInflight(req, "A");
        // garbage data
        const bad = Buffer.alloc(req.length, 0x42);
        const result = pmBad.addBlock(req, bad, "A");
        if (b === numBlocks - 1) {
            assert.strictEqual(result.kind, "rejected");
        }
    }
    assert.ok(!pmBad.haveBitfield.get(0));

    // removePeer returns in-flight blocks so they can be re-requested
    const pmDc = new PieceManager(metaWithHash, { pieceRange: { from: 0, toExclusive: 1 } });
    pmDc.addPeer("A", peerA);
    const r1 = pmDc.pickBlock("A");
    assert.ok(r1);
    pmDc.markInflight(r1, "A");
    const returned = pmDc.removePeer("A");
    assert.strictEqual(returned.length, 1);
    assert.strictEqual(returned[0].pieceIndex, r1.pieceIndex);
    assert.strictEqual(returned[0].begin, r1.begin);

    // markHaves: only selected+set pieces become done, bytes counted
    const pmHave = new PieceManager(meta, { pieceRange: { from: 2, toExclusive: 5 } });
    const haveBf = new Bitfield(10);
    haveBf.set(0); // not selected → ignored
    haveBf.set(3); // selected → adopted
    pmHave.markHaves(haveBf);
    assert.ok(!pmHave.haveBitfield.get(0));
    assert.ok(pmHave.haveBitfield.get(3));
    assert.ok(!pmHave.haveBitfield.get(2));
    assert.strictEqual(pmHave.downloadedBytes, 256 * 1024);

    console.log("PieceManager tests passed.");
}
