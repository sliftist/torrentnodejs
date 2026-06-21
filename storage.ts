import { open, mkdir, rename, stat, rm } from "fs/promises";
import { constants as fsConstants } from "fs";
import crypto from "crypto";
import path from "path";
import { TorrentMeta, TorrentFile, pieceLengthAt } from "./torrentFile";
import { Bitfield } from "./bitfield";

interface FilePlan {
    file: TorrentFile;
    finalPath: string;
    tempPath: string;
    // Only allocated/touched files are read or written; others are skipped on
    // write and throw on read.
    allocated: boolean;
    // True once every piece of this file is present and it has been renamed
    // from the temp dir into its final location.
    finalized: boolean;
}

// Drive-letter (C:\ or C:/) prefix — used to keep the temp dir on the same
// volume as the final files so the completion rename never crosses devices.
const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;

// Maps the linear concatenated piece stream onto one or more on-disk files.
//
// In-progress files are written into a temp directory on the same volume as the
// save directory; once all of a file's pieces are present, it is renamed into
// its final location. This keeps half-written files out of the save dir and,
// together with transient handles (every read/write opens, ops, then closes),
// keeps the process well under its file-descriptor limit even with thousands of
// torrents — a persistent FileHandle per file would exhaust them (EMFILE).
export class Storage {
    private filePlans: FilePlan[] = [];
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
        const tempBase = this.incompleteDir();
        for (const f of this.meta.files) {
            const finalPath = path.join(this.saveDir, ...f.path);
            const tempPath = this.joinSameFlavor(tempBase, f.path);
            const allocated = touchedFiles.has(f);
            const plan: FilePlan = { file: f, finalPath, tempPath, allocated, finalized: false };
            this.filePlans.push(plan);
            if (!allocated) continue;
            // Already complete from a previous run? Read it straight from its
            // final spot; no temp file needed.
            const finalStat = await stat(finalPath).catch(() => undefined);
            if (finalStat && finalStat.size === f.length) {
                plan.finalized = true;
                continue;
            }
            await this.allocate(tempPath, f.length);
        }
    }

    async close(): Promise<void> {
        this.filePlans = [];
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

    // Rename every file whose pieces are all present (per `have`) from the temp
    // dir into its final location. Idempotent — already-finalized files are
    // skipped. Once nothing remains in the temp dir it is removed.
    async finalizeFiles(have: Bitfield): Promise<void> {
        if (!this.opened) throw new Error("Storage not open");
        for (const plan of this.filePlans) {
            if (!plan.allocated || plan.finalized) continue;
            if (!this.fileComplete(plan.file, have)) continue;
            await mkdir(path.dirname(plan.finalPath), { recursive: true });
            await rename(plan.tempPath, plan.finalPath);
            plan.finalized = true;
        }
        if (this.filePlans.every((p) => !p.allocated || p.finalized)) {
            await rm(this.incompleteDir(), { recursive: true, force: true }).catch(() => {});
        }
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

    // O_RDWR | O_CREAT — create if missing, don't truncate existing data.
    // Truncate only to grow/shrink to the final size, so writes are sparse and
    // a resumed partial file keeps its bytes.
    private async allocate(filePath: string, length: number): Promise<void> {
        await mkdir(path.dirname(filePath), { recursive: true });
        const handle = await open(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
        try {
            const s = await handle.stat();
            if (s.size !== length) await handle.truncate(length);
        } finally {
            await handle.close();
        }
    }

    private async writeAt(absoluteOffset: number, data: Buffer): Promise<void> {
        let cursor = 0;
        for (const plan of this.filePlans) {
            const file = plan.file;
            const fileEnd = file.offsetInTorrent + file.length;
            if (absoluteOffset + cursor >= fileEnd) continue;
            if (absoluteOffset + data.length <= file.offsetInTorrent) break;
            const writeStart = Math.max(absoluteOffset + cursor, file.offsetInTorrent);
            const writeEnd = Math.min(absoluteOffset + data.length, fileEnd);
            const fileOffset = writeStart - file.offsetInTorrent;
            const dataOffset = writeStart - absoluteOffset;
            const sliceLength = writeEnd - writeStart;
            cursor = writeEnd - absoluteOffset;
            // File not allocated (outside selection). Skip silently.
            if (!plan.allocated) continue;
            const handle = await open(this.activePath(plan), fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
            try {
                await handle.write(data, dataOffset, sliceLength, fileOffset);
            } finally {
                await handle.close();
            }
        }
    }

    private async readAt(absoluteOffset: number, length: number): Promise<Buffer> {
        const out = Buffer.alloc(length);
        for (const plan of this.filePlans) {
            const file = plan.file;
            const fileEnd = file.offsetInTorrent + file.length;
            if (absoluteOffset >= fileEnd) continue;
            if (absoluteOffset + length <= file.offsetInTorrent) break;
            const readStart = Math.max(absoluteOffset, file.offsetInTorrent);
            const readEnd = Math.min(absoluteOffset + length, fileEnd);
            const fileOffset = readStart - file.offsetInTorrent;
            const outOffset = readStart - absoluteOffset;
            const sliceLength = readEnd - readStart;
            if (!plan.allocated) {
                throw new Error(`Read from unallocated file ${file.path.join("/")}`);
            }
            const handle = await open(this.activePath(plan), fsConstants.O_RDONLY);
            try {
                await handle.read(out, outOffset, sliceLength, fileOffset);
            } finally {
                await handle.close();
            }
        }
        return out;
    }

    private activePath(plan: FilePlan): string {
        if (plan.finalized) return plan.finalPath;
        return plan.tempPath;
    }

    private fileComplete(file: TorrentFile, have: Bitfield): boolean {
        if (file.length === 0) return true;
        const firstPiece = Math.floor(file.offsetInTorrent / this.meta.pieceLength);
        const lastPiece = Math.floor((file.offsetInTorrent + file.length - 1) / this.meta.pieceLength);
        for (let i = firstPiece; i <= lastPiece; i++) {
            if (!have.get(i)) return false;
        }
        return true;
    }

    // Temp dir for this torrent's in-progress files, on the same volume as the
    // save dir so the completion rename is a cheap, atomic, in-device move.
    private incompleteDir(): string {
        const hash = this.meta.infoHash.toString("hex");
        const drive = WINDOWS_DRIVE.exec(this.saveDir);
        if (drive) return path.win32.join(`${drive[1]}:\\`, "temp", "bittorrent-incomplete", hash);
        return path.join(this.saveDir, ".bittorrent-incomplete", hash);
    }

    private joinSameFlavor(base: string, parts: string[]): string {
        if (WINDOWS_DRIVE.test(base)) return path.win32.join(base, ...parts);
        return path.join(base, ...parts);
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
