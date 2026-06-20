import { open, mkdir, FileHandle } from "fs/promises";
import { constants as fsConstants } from "fs";
import crypto from "crypto";
import path from "path";
import { TorrentMeta, TorrentFile, pieceLengthAt } from "./torrentFile";
import { Bitfield } from "./bitfield";

interface FileSlot {
    handle: FileHandle;
    fullLength: number;
    offsetInTorrent: number;
}

// Maps the linear concatenated piece stream onto one or more on-disk files.
// Pre-allocates each touched file to its final size so writes are sparse and
// random-access works without seek games.
export class Storage {
    private fileSlots: FileSlot[] = [];
    private opened = false;

    constructor(
        private readonly meta: TorrentMeta,
        private readonly saveDir: string,
        // If provided, files outside the touched set are NOT allocated.
        // A "touched" file is one that overlaps with the active piece selection.
        private readonly touchedPieces?: Set<number>,
    ) {}

    async open(): Promise<void> {
        if (this.opened) return;
        this.opened = true;
        const touchedFiles = this.computeTouchedFiles();
        for (const f of this.meta.files) {
            if (!touchedFiles.has(f)) {
                this.fileSlots.push(null as unknown as FileSlot); // placeholder so indices line up
                continue;
            }
            const filePath = path.join(this.saveDir, ...f.path);
            await mkdir(path.dirname(filePath), { recursive: true });
            // O_RDWR | O_CREAT — random-access read/write, create if missing,
            // don't truncate. The string flags "a+" / "w+" don't fit:
            // "a+" forces all writes to EOF (kernel O_APPEND ignores position),
            // "w+" truncates existing data on open.
            const handle = await open(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
            const stat = await handle.stat();
            if (stat.size !== f.length) {
                await handle.truncate(f.length);
            }
            this.fileSlots.push({ handle, fullLength: f.length, offsetInTorrent: f.offsetInTorrent });
        }
    }

    async close(): Promise<void> {
        for (const slot of this.fileSlots) {
            if (slot) await slot.handle.close();
        }
        this.fileSlots = [];
        this.opened = false;
    }

    async writePiece(pieceIndex: number, data: Buffer): Promise<void> {
        if (!this.opened) throw new Error("Storage not open");
        const expected = pieceLengthAt(this.meta, pieceIndex);
        if (data.length !== expected) {
            throw new Error(`Piece ${pieceIndex} length ${data.length} != expected ${expected}`);
        }
        const pieceStart = pieceIndex * this.meta.pieceLength;
        await this.writeAt(pieceStart, data);
    }

    // Read every candidate piece from disk and SHA-1-check it against the
    // torrent's hash list. Returns a Bitfield of pieces that are present and
    // valid. By default checks the touched/selected pieces (the only ones we
    // allocate); pass an explicit set to narrow further. Used on startup to
    // resume a partial download or confirm a seed without re-downloading.
    async verifyExistingPieces(candidates?: Iterable<number>): Promise<Bitfield> {
        if (!this.opened) throw new Error("Storage not open");
        const result = new Bitfield(this.meta.pieceHashes.length);
        const toCheck = candidates
            ? [...candidates]
            : (this.touchedPieces ? [...this.touchedPieces] : this.meta.pieceHashes.map((_, i) => i));
        for (const i of toCheck) {
            if (i < 0 || i >= this.meta.pieceHashes.length) continue;
            let data: Buffer;
            try {
                data = await this.readAt(i * this.meta.pieceLength, pieceLengthAt(this.meta, i));
            } catch {
                continue; // file not allocated / unreadable → treat as missing
            }
            const computed = crypto.createHash("sha1").update(data).digest();
            if (computed.equals(this.meta.pieceHashes[i])) result.set(i);
        }
        return result;
    }

    async readBlock(pieceIndex: number, begin: number, length: number): Promise<Buffer> {
        if (!this.opened) throw new Error("Storage not open");
        const pieceStart = pieceIndex * this.meta.pieceLength;
        return this.readAt(pieceStart + begin, length);
    }

    private async writeAt(absoluteOffset: number, data: Buffer): Promise<void> {
        let cursor = 0;
        for (let i = 0; i < this.meta.files.length; i++) {
            const slot = this.fileSlots[i];
            const file = this.meta.files[i];
            const fileEnd = file.offsetInTorrent + file.length;
            if (absoluteOffset + cursor >= fileEnd) continue;
            if (absoluteOffset + data.length <= file.offsetInTorrent) break;
            const writeStart = Math.max(absoluteOffset + cursor, file.offsetInTorrent);
            const writeEnd = Math.min(absoluteOffset + data.length, fileEnd);
            const fileOffset = writeStart - file.offsetInTorrent;
            const dataOffset = writeStart - absoluteOffset;
            const sliceLength = writeEnd - writeStart;
            if (!slot) {
                // File not allocated (outside selection). Skip silently.
                cursor = writeEnd - absoluteOffset;
                continue;
            }
            await slot.handle.write(data, dataOffset, sliceLength, fileOffset);
            cursor = writeEnd - absoluteOffset;
        }
    }

    private async readAt(absoluteOffset: number, length: number): Promise<Buffer> {
        const out = Buffer.alloc(length);
        for (let i = 0; i < this.meta.files.length; i++) {
            const slot = this.fileSlots[i];
            const file = this.meta.files[i];
            const fileEnd = file.offsetInTorrent + file.length;
            if (absoluteOffset >= fileEnd) continue;
            if (absoluteOffset + length <= file.offsetInTorrent) break;
            const readStart = Math.max(absoluteOffset, file.offsetInTorrent);
            const readEnd = Math.min(absoluteOffset + length, fileEnd);
            const fileOffset = readStart - file.offsetInTorrent;
            const outOffset = readStart - absoluteOffset;
            const sliceLength = readEnd - readStart;
            if (!slot) {
                throw new Error(`Read from unallocated file ${file.path.join("/")}`);
            }
            await slot.handle.read(out, outOffset, sliceLength, fileOffset);
        }
        return out;
    }

    private computeTouchedFiles(): Set<TorrentFile> {
        const touched = new Set<TorrentFile>();
        if (!this.touchedPieces) {
            for (const f of this.meta.files) touched.add(f);
            return touched;
        }
        const piecesByteRanges: { start: number; end: number }[] = [];
        for (const p of this.touchedPieces) {
            const start = p * this.meta.pieceLength;
            const end = start + pieceLengthAt(this.meta, p);
            piecesByteRanges.push({ start, end });
        }
        for (const f of this.meta.files) {
            const fEnd = f.offsetInTorrent + f.length;
            for (const r of piecesByteRanges) {
                if (r.start < fEnd && r.end > f.offsetInTorrent) {
                    touched.add(f);
                    break;
                }
            }
        }
        return touched;
    }
}
