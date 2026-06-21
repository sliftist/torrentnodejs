import crypto from "crypto";
import { EventEmitter } from "events";
import { TorrentMeta, pieceLengthAt } from "./torrentFile";
import { Bitfield } from "./bitfield";

export const BLOCK_SIZE = 16 * 1024;

// Once this few blocks remain unfetched we enter endgame: the final blocks get
// requested from every available peer at once and the duplicates are cancelled
// as soon as one arrives, so a single slow peer can't stall us at ~99%.
export const ENDGAME_BLOCK_THRESHOLD = 50;

export interface PieceSelection {
    // Pick by explicit piece indices, an [from, toExclusive) piece range,
    // file paths in the torrent, and/or a byte range within the concatenated
    // piece stream. The final selected set is the UNION of all that apply.
    // If nothing is set, the whole torrent is selected.
    pieces?: number[];
    pieceRange?: { from: number; toExclusive: number };
    files?: string[];
    byteRange?: { start: number; endExclusive: number };
}

export interface BlockRequest {
    pieceIndex: number;
    begin: number;
    length: number;
}

// A duplicate in-flight request (on a different peer) that should now be
// cancelled because the block arrived. Only populated during endgame.
export interface CanceledRequest {
    peerId: string;
    pieceIndex: number;
    begin: number;
    length: number;
}

export interface PieceManagerEvents {
    "piece-complete": (index: number) => void;
    "piece-failed": (index: number) => void;
    "complete": () => void;
}

export type PieceState = "needed" | "downloading" | "done";

interface PieceProgress {
    state: PieceState;
    blocks: { length: number; have: boolean; inflight: number }[];
    receivedBytes: number;
    buffer?: Buffer;
}

interface InflightEntry {
    pieceIndex: number;
    blockIndex: number;
    peerId: string;
    sentAtMs: number;
}

export class PieceManager extends EventEmitter {
    readonly numPieces: number;
    readonly selected: Set<number>;
    readonly haveBitfield: Bitfield;
    private readonly progress: PieceProgress[];
    private readonly pieceHashes: Buffer[];
    private readonly rarityCounts: Map<number, number> = new Map();
    private readonly peerBitfields = new Map<string, Bitfield>();
    private readonly inflight = new Map<string, InflightEntry>(); // key = `${piece}:${blockIndex}:${peerId}`
    // Pieces a web client explicitly requested; picked before everything else.
    private readonly priorityPieces = new Set<number>();
    private downloadedBytesField = 0;

    constructor(
        private readonly meta: TorrentMeta,
        selection?: PieceSelection,
    ) {
        super();
        this.numPieces = meta.pieceHashes.length;
        this.pieceHashes = meta.pieceHashes;
        this.selected = computeSelectedPieces(meta, selection);
        this.haveBitfield = new Bitfield(this.numPieces);
        this.progress = [];
        for (let i = 0; i < this.numPieces; i++) {
            if (!this.selected.has(i)) {
                this.progress.push({ state: "done", blocks: [], receivedBytes: 0 });
                continue;
            }
            const pl = pieceLengthAt(meta, i);
            const blocks: PieceProgress["blocks"] = [];
            for (let off = 0; off < pl; off += BLOCK_SIZE) {
                blocks.push({ length: Math.min(BLOCK_SIZE, pl - off), have: false, inflight: 0 });
            }
            this.progress.push({ state: "needed", blocks, receivedBytes: 0 });
        }
    }

    get downloadedBytes(): number { return this.downloadedBytesField; }

    get totalSelectedBytes(): number {
        let n = 0;
        for (const p of this.selected) n += pieceLengthAt(this.meta, p);
        return n;
    }

    isComplete(): boolean {
        for (const p of this.selected) if (this.progress[p].state !== "done") return false;
        return true;
    }

    // Snapshot of every piece's state, for the detail/piece-map view. Pieces
    // outside the selection report "done" (we treat them as not-our-concern).
    pieceStates(): PieceState[] {
        return this.progress.map((p) => p.state);
    }

    get pieceCounts(): { needed: number; downloading: number; done: number } {
        const counts = { needed: 0, downloading: 0, done: 0 };
        for (const i of this.selected) counts[this.progress[i].state]++;
        return counts;
    }

    // Blocks we still don't have across every not-done selected piece.
    remainingBlocks(): number {
        let n = 0;
        for (const i of this.selected) {
            const p = this.progress[i];
            if (p.state === "done") continue;
            for (const b of p.blocks) if (!b.have) n++;
        }
        return n;
    }

    inEndgame(): boolean {
        const remaining = this.remainingBlocks();
        return remaining > 0 && remaining <= ENDGAME_BLOCK_THRESHOLD;
    }

    // For pure-seeder mode: declare every selected piece already done without
    // verifying (caller has guaranteed the on-disk file is intact). Also
    // counts the piece bytes as "have" so the tracker sees us as a seeder.
    markAllSelectedDone(): void {
        for (const i of this.selected) {
            if (this.progress[i].state === "done") continue;
            this.progress[i].state = "done";
            this.progress[i].buffer = undefined;
            this.haveBitfield.set(i);
            this.downloadedBytesField += pieceLengthAt(this.meta, i);
        }
    }

    // Mark a specific set of already-verified pieces as done (e.g. pieces
    // confirmed on disk by Storage.verifyExistingPieces). Only pieces that are
    // both selected and not already done are applied; their bytes count toward
    // downloaded so the tracker sees correct progress.
    markHaves(have: Bitfield): void {
        for (const i of this.selected) {
            if (!have.get(i)) continue;
            if (this.progress[i].state === "done") continue;
            this.progress[i].state = "done";
            this.progress[i].buffer = undefined;
            this.haveBitfield.set(i);
            this.downloadedBytesField += pieceLengthAt(this.meta, i);
        }
    }

    addPeer(peerId: string, bitfield: Bitfield): void {
        const prev = this.peerBitfields.get(peerId);
        if (prev) this.removePeer(peerId);
        this.peerBitfields.set(peerId, bitfield);
        for (let i = 0; i < this.numPieces; i++) {
            if (bitfield.get(i) && this.selected.has(i)) {
                this.rarityCounts.set(i, (this.rarityCounts.get(i) || 0) + 1);
            }
        }
    }

    updatePeerHave(peerId: string, pieceIndex: number): void {
        const bf = this.peerBitfields.get(peerId);
        if (!bf) {
            // Peer hadn't sent a bitfield yet — treat as empty bitfield
            const empty = new Bitfield(this.numPieces);
            this.peerBitfields.set(peerId, empty);
        }
        const cur = this.peerBitfields.get(peerId);
        if (!cur || cur.get(pieceIndex)) return;
        cur.set(pieceIndex);
        if (this.selected.has(pieceIndex)) {
            this.rarityCounts.set(pieceIndex, (this.rarityCounts.get(pieceIndex) || 0) + 1);
        }
    }

    removePeer(peerId: string): BlockRequest[] {
        const bf = this.peerBitfields.get(peerId);
        if (bf) {
            for (let i = 0; i < this.numPieces; i++) {
                if (bf.get(i) && this.selected.has(i)) {
                    const c = (this.rarityCounts.get(i) || 0) - 1;
                    if (c <= 0) this.rarityCounts.delete(i);
                    else this.rarityCounts.set(i, c);
                }
            }
            this.peerBitfields.delete(peerId);
        }
        const returned: BlockRequest[] = [];
        for (const [key, entry] of [...this.inflight]) {
            if (entry.peerId !== peerId) continue;
            const piece = this.progress[entry.pieceIndex];
            const block = piece.blocks[entry.blockIndex];
            block.inflight = Math.max(0, block.inflight - 1);
            this.inflight.delete(key);
            if (!block.have) {
                returned.push({
                    pieceIndex: entry.pieceIndex,
                    begin: entry.blockIndex * BLOCK_SIZE,
                    length: block.length,
                });
            }
        }
        return returned;
    }

    // Mark a piece as priority so the next requests fetch it ahead of the normal
    // rarest-first order. No-op for pieces outside the selection.
    prioritizePiece(pieceIndex: number): void {
        if (pieceIndex < 0 || pieceIndex >= this.numPieces) return;
        if (!this.selected.has(pieceIndex)) return;
        if (this.progress[pieceIndex].state === "done") return;
        this.priorityPieces.add(pieceIndex);
    }

    // Pick the next block to request from this peer. Rarest-first across
    // pieces they have AND we need, falling back to random among rarest.
    pickBlock(peerId: string): BlockRequest | undefined {
        const peerBf = this.peerBitfields.get(peerId);
        if (!peerBf) return undefined;

        // Priority pass: explicitly-requested pieces win, even during endgame.
        for (const i of this.priorityPieces) {
            const p = this.progress[i];
            if (p.state === "done") { this.priorityPieces.delete(i); continue; }
            if (!peerBf.get(i)) continue;
            if (p.state === "needed") {
                p.state = "downloading";
                p.buffer = Buffer.alloc(pieceLengthAt(this.meta, i));
            }
            const blockIdx = nextNeededBlock(p);
            if (blockIdx < 0) continue;
            return { pieceIndex: i, begin: blockIdx * BLOCK_SIZE, length: p.blocks[blockIdx].length };
        }

        if (this.inEndgame()) return this.pickBlockEndgame(peerBf, peerId);
        const candidates: { pieceIndex: number; rarity: number }[] = [];
        let minRarity = Infinity;

        // First pass: pieces already being downloaded that this peer has
        // (finish what we started before starting new pieces)
        for (let i = 0; i < this.numPieces; i++) {
            if (!this.selected.has(i)) continue;
            const p = this.progress[i];
            if (p.state !== "downloading") continue;
            if (!peerBf.get(i)) continue;
            const blockIdx = nextNeededBlock(p);
            if (blockIdx < 0) continue;
            return { pieceIndex: i, begin: blockIdx * BLOCK_SIZE, length: p.blocks[blockIdx].length };
        }

        // Second pass: pieces that are "needed" — pick rarest
        for (let i = 0; i < this.numPieces; i++) {
            if (!this.selected.has(i)) continue;
            if (this.progress[i].state !== "needed") continue;
            if (!peerBf.get(i)) continue;
            const rarity = this.rarityCounts.get(i) || 0;
            if (rarity < minRarity) {
                candidates.length = 0;
                minRarity = rarity;
            }
            if (rarity === minRarity) candidates.push({ pieceIndex: i, rarity });
        }
        if (candidates.length === 0) return undefined;
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        const piece = this.progress[pick.pieceIndex];
        piece.state = "downloading";
        piece.buffer = Buffer.alloc(pieceLengthAt(this.meta, pick.pieceIndex));
        const blockIdx = nextNeededBlock(piece);
        if (blockIdx < 0) return undefined;
        return { pieceIndex: pick.pieceIndex, begin: blockIdx * BLOCK_SIZE, length: piece.blocks[blockIdx].length };
    }

    // Endgame picker: hand out any block this peer has that we still don't,
    // even if it's already in flight to another peer — but never the same block
    // twice to the same peer. Duplicates get cancelled when one copy lands.
    private pickBlockEndgame(peerBf: Bitfield, peerId: string): BlockRequest | undefined {
        for (let i = 0; i < this.numPieces; i++) {
            if (!this.selected.has(i)) continue;
            const p = this.progress[i];
            if (p.state === "done") continue;
            if (!peerBf.get(i)) continue;
            for (let blockIdx = 0; blockIdx < p.blocks.length; blockIdx++) {
                const block = p.blocks[blockIdx];
                if (block.have) continue;
                if (this.inflight.has(`${i}:${blockIdx}:${peerId}`)) continue;
                if (p.state === "needed") {
                    p.state = "downloading";
                    p.buffer = Buffer.alloc(pieceLengthAt(this.meta, i));
                }
                return { pieceIndex: i, begin: blockIdx * BLOCK_SIZE, length: block.length };
            }
        }
        return undefined;
    }

    markInflight(req: BlockRequest, peerId: string): void {
        const piece = this.progress[req.pieceIndex];
        const blockIndex = req.begin / BLOCK_SIZE;
        const block = piece.blocks[blockIndex];
        if (!block || block.have) return;
        block.inflight++;
        const key = `${req.pieceIndex}:${blockIndex}:${peerId}`;
        this.inflight.set(key, { pieceIndex: req.pieceIndex, blockIndex, peerId, sentAtMs: Date.now() });
    }

    // Returns the SHA-1-verified, fully-assembled piece buffer if completion
    // and verification succeeded; undefined if the block was stored but the
    // piece isn't complete yet; throws if rejected/duplicate/wrong-hash.
    addBlock(req: BlockRequest, data: Buffer, peerId: string): { kind: "stored"; canceled: CanceledRequest[] } | { kind: "complete"; piece: Buffer; canceled: CanceledRequest[] } | { kind: "duplicate" } | { kind: "rejected"; reason: string } {
        if (!this.selected.has(req.pieceIndex)) return { kind: "rejected", reason: "piece not selected" };
        const piece = this.progress[req.pieceIndex];
        if (piece.state === "done") return { kind: "duplicate" };
        if (piece.state !== "downloading" || !piece.buffer) return { kind: "rejected", reason: "piece not in flight" };
        if (req.begin % BLOCK_SIZE !== 0) return { kind: "rejected", reason: `unaligned begin ${req.begin}` };
        const blockIndex = req.begin / BLOCK_SIZE;
        const block = piece.blocks[blockIndex];
        if (!block) return { kind: "rejected", reason: `block ${blockIndex} out of range` };
        if (data.length !== block.length) return { kind: "rejected", reason: `length ${data.length} != expected ${block.length}` };
        if (block.have) return { kind: "duplicate" };

        data.copy(piece.buffer, req.begin);
        block.have = true;
        block.inflight = 0;
        piece.receivedBytes += data.length;
        this.downloadedBytesField += data.length;

        // Clean inflight entries for this block from ALL peers. Any that were
        // pending on OTHER peers (endgame duplicates) are reported so the caller
        // can send cancels.
        const canceled: CanceledRequest[] = [];
        for (const [key, entry] of [...this.inflight]) {
            if (entry.pieceIndex === req.pieceIndex && entry.blockIndex === blockIndex) {
                if (entry.peerId !== peerId) {
                    canceled.push({ peerId: entry.peerId, pieceIndex: req.pieceIndex, begin: req.begin, length: block.length });
                }
                this.inflight.delete(key);
            }
        }

        if (piece.blocks.every((b) => b.have)) {
            const computed = crypto.createHash("sha1").update(piece.buffer).digest();
            if (!computed.equals(this.pieceHashes[req.pieceIndex])) {
                this.resetPiece(req.pieceIndex);
                this.emit("piece-failed", req.pieceIndex);
                return { kind: "rejected", reason: "piece SHA-1 mismatch" };
            }
            const finalBuffer = piece.buffer;
            piece.state = "done";
            piece.buffer = undefined;
            this.haveBitfield.set(req.pieceIndex);
            // Don't emit "complete" from here — let the Torrent coordinator
            // do it AFTER it has written the piece to storage and emitted
            // "piece" itself, so observers see the events in order.
            this.emit("piece-complete", req.pieceIndex);
            return { kind: "complete", piece: finalBuffer, canceled };
        }
        return { kind: "stored", canceled };
    }

    private resetPiece(pieceIndex: number): void {
        const piece = this.progress[pieceIndex];
        for (const b of piece.blocks) { b.have = false; b.inflight = 0; }
        piece.receivedBytes = 0;
        piece.state = "needed";
        piece.buffer = undefined;
    }
}

function nextNeededBlock(piece: PieceProgress): number {
    for (let i = 0; i < piece.blocks.length; i++) {
        if (!piece.blocks[i].have && piece.blocks[i].inflight === 0) return i;
    }
    return -1;
}

function computeSelectedPieces(meta: TorrentMeta, sel?: PieceSelection): Set<number> {
    const out = new Set<number>();
    const numPieces = meta.pieceHashes.length;
    const empty = !sel || (sel.pieces === undefined && sel.pieceRange === undefined && sel.files === undefined && sel.byteRange === undefined);
    if (empty) {
        for (let i = 0; i < numPieces; i++) out.add(i);
        return out;
    }
    if (sel.pieces) for (const i of sel.pieces) if (i >= 0 && i < numPieces) out.add(i);
    if (sel.pieceRange) {
        const from = Math.max(0, sel.pieceRange.from);
        const to = Math.min(numPieces, sel.pieceRange.toExclusive);
        for (let i = from; i < to; i++) out.add(i);
    }
    if (sel.byteRange) {
        const startPiece = Math.floor(sel.byteRange.start / meta.pieceLength);
        const endPiece = Math.ceil(sel.byteRange.endExclusive / meta.pieceLength);
        for (let i = Math.max(0, startPiece); i < Math.min(numPieces, endPiece); i++) out.add(i);
    }
    if (sel.files) {
        for (const file of meta.files) {
            const pathStr = file.path.join("/");
            if (!sel.files.includes(pathStr)) continue;
            const startPiece = Math.floor(file.offsetInTorrent / meta.pieceLength);
            const endPiece = Math.ceil((file.offsetInTorrent + file.length) / meta.pieceLength);
            for (let i = startPiece; i < endPiece; i++) out.add(i);
        }
    }
    return out;
}
