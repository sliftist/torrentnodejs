import { open, mkdir, rename, stat, rm, readFile, writeFile, FileHandle } from "fs/promises";
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
    // Raw stat of the file physically on disk at finalPath, if any. Set even when
    // the size doesn't match the torrent's expected length — that's how we read
    // and salvage a partial or mismatched output file rather than reporting 0%.
    existingFinalSize?: number;
    existingFinalMtimeMs?: number;
    // Raw stat of the in-progress temp copy when it (and not a final output file)
    // backs this plan's bytes. Only recorded when there's no final file, since
    // existingSource() always prefers the final file when one is present.
    existingTempSize?: number;
    existingTempMtimeMs?: number;
}

// On-disk record of a previous verification, stored alongside the output files.
// If every output file's size and mtime still match, the cached `have` is reused
// instead of re-hashing — so repeat scans of an unchanged downloads folder are
// near-instant.
interface CheckedCache {
    version: number;
    pieceCount: number;
    files: Record<string, { size: number; mtimeMs: number }>;
    have: string;
}

const CHECKED_CACHE_DIR = ".bittorrent-checked";
const CHECKED_CACHE_VERSION = 1;

// Process-wide disk I/O byte counters, sampled by the UI to show an actual
// file-I/O throughput. Incremented by every real read/write of file data
// (verification reads, block writes, upload reads) — not by allocation.
export const diskIO = { bytesRead: 0, bytesWritten: 0 };

// Verified-piece cache diagnostics, sampled by tooling (e.g. the check harness)
// to confirm the cache is actually being persisted and reused. writeFailures
// rising while loadHits stays flat is the signature of a cache that silently
// can't write to the save dir (permissions, a full or read-only mount, or
// running out of file descriptors at scale), which forces a full re-hash every
// startup.
export const cacheStats = { writes: 0, writeFailures: 0, loads: 0, loadHits: 0, lastWriteError: "" };

// Drive-letter (C:\ or C:/) prefix — used to keep the temp dir on the same
// volume as the final files so the completion rename never crosses devices.
const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]/;

// fs read/write may transfer fewer bytes than requested in a single call — a
// documented Node caveat that bites on Windows (large reads routinely come back
// short) while Linux usually fills the whole request, so a single read/write
// silently leaves the buffer tail untouched and every SHA-1 mismatches. Loop
// until the full range is moved (or EOF, for reads).
async function readFully(handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    let total = 0;
    while (total < length) {
        const { bytesRead } = await handle.read(buffer, offset + total, length - total, position + total);
        if (bytesRead === 0) break;
        total += bytesRead;
    }
    return total;
}

async function writeFully(handle: FileHandle, buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
    let total = 0;
    while (total < length) {
        const { bytesWritten } = await handle.write(buffer, offset + total, length - total, position + total);
        if (bytesWritten === 0) throw new Error(`Wrote 0 of ${length - total} remaining bytes at position ${position + total}`);
        total += bytesWritten;
    }
}

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
            // Record any existing output file's stat for verify/import/cache, even
            // for files we won't actively write (so a scan can read them too).
            // existingSource() turns these raw stats into the single decision of
            // which file backs this plan's bytes.
            const finalStat = await stat(finalPath).catch(() => undefined);
            if (finalStat) {
                plan.existingFinalSize = finalStat.size;
                plan.existingFinalMtimeMs = finalStat.mtimeMs;
            }
            if (!allocated) continue;
            // Already complete from a previous run? Read it straight from its
            // final spot; no temp file needed.
            if (finalStat && finalStat.size === f.length) {
                plan.finalized = true;
                continue;
            }
            await this.allocate(tempPath, f.length);
            // With no final output file, the temp copy we just ensured backs
            // reads; record its stat so a repeat scan trusts it from the cache.
            // (When a final file exists, existingSource prefers it, so the temp
            // stat would be unused — skip it.)
            if (!finalStat) {
                const tempStat = await stat(tempPath).catch(() => undefined);
                if (tempStat) {
                    plan.existingTempSize = tempStat.size;
                    plan.existingTempMtimeMs = tempStat.mtimeMs;
                }
            }
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
    async verifyExistingPieces(
        candidates?: Iterable<number>,
        // When importToTemp is set, every piece that verifies against an
        // existing output file is copied into the in-progress temp file, so the
        // download only has to fetch the missing/corrupt pieces. The original
        // output file is left untouched until the download finishes and renames
        // the temp file over it.
        // onMismatch reports every piece whose on-disk bytes don't hash to the
        // expected value (a diagnostic for the `check` script); supplying it
        // also forces a full re-hash, bypassing the cache entirely.
        config?: { importToTemp?: boolean; onMismatch?: (info: { index: number; computed: Buffer; expected: Buffer }) => void },
    ): Promise<Bitfield> {
        if (!this.opened) throw new Error("Storage not open");

        const result = new Bitfield(this.meta.pieceHashes.length);
        const toCheck = candidates
            ? [...candidates]
            : (this.touchedPieces ? [...this.touchedPieces] : this.meta.pieceHashes.map((_, i) => i));

        // Per-file (size+mtime) → verified-piece cache. A piece is trusted from
        // the cache only when every file it overlaps is still present at the
        // same size and mtime, so a single changed/corrupt/missing file forces a
        // re-hash of just its own pieces rather than the whole torrent — and
        // unchanged files (including ones whose pieces are known-bad) are never
        // re-hashed on later startups. The diagnostic `check` path ignores the
        // cache so it always reads and reports real on-disk state.
        const cached = config?.onMismatch ? undefined : await this.loadCheckedCache();
        const cachedHave = cached && cached.pieceCount === this.meta.pieceHashes.length
            && new Bitfield(this.meta.pieceHashes.length, Buffer.from(cached.have, "base64"));

        const valid: { index: number; data: Buffer }[] = [];
        for (const i of toCheck) {
            if (i < 0 || i >= this.meta.pieceHashes.length) continue;
            if (cachedHave && cached && this.pieceUnchanged(i, cached)) {
                if (cachedHave.get(i)) result.set(i);
                continue; // trust the cached result; no read, no hash
            }
            let data: Buffer;
            try {
                data = await this.readAt(i * this.meta.pieceLength, pieceLengthAt(this.meta, i), "existing");
            } catch {
                continue; // unreadable → treat as missing
            }
            const computed = crypto.createHash("sha1").update(data).digest();
            const expected = this.meta.pieceHashes[i];
            if (!computed.equals(expected)) {
                config?.onMismatch?.({ index: i, computed, expected });
                continue;
            }
            result.set(i);
            valid.push({ index: i, data });
        }

        if (config?.importToTemp) {
            // A right-sized file we optimistically read in place might still turn
            // out to be the wrong content (failed verification). Demote it to the
            // temp copy so the original output is left untouched until the
            // re-download completes and renames over it.
            for (const plan of this.filePlans) {
                if (!plan.finalized || this.fileComplete(plan.file, result)) continue;
                plan.finalized = false;
                if (plan.existingFinalSize === undefined) plan.existingFinalSize = plan.file.length;
                await this.allocate(plan.tempPath, plan.file.length);
            }
            // Pieces trusted from the cache weren't read above; any that are good
            // and now belong to a demoted (temp-backed) file still need their
            // bytes copied into the temp file, so read just those on demand.
            const haveData = new Set(valid.map((v) => v.index));
            for (const i of toCheck) {
                if (!result.get(i) || haveData.has(i)) continue;
                if (this.plansForPiece(i).every((p) => p.finalized)) continue;
                const data = await this.readAt(i * this.meta.pieceLength, pieceLengthAt(this.meta, i), "existing").catch(() => undefined);
                if (data) valid.push({ index: i, data });
            }
            for (const { index, data } of valid) {
                await this.writeAt(index * this.meta.pieceLength, data, "tempOnly");
            }
        }

        if (!config?.onMismatch) await this.writeCheckedCache(result);
        return result;
    }

    // FilePlans whose byte range overlaps piece `index`.
    private plansForPiece(index: number): FilePlan[] {
        const start = index * this.meta.pieceLength;
        const end = start + pieceLengthAt(this.meta, index);
        const out: FilePlan[] = [];
        for (const plan of this.filePlans) {
            const fEnd = plan.file.offsetInTorrent + plan.file.length;
            if (start < fEnd && end > plan.file.offsetInTorrent) out.push(plan);
        }
        return out;
    }

    // A piece can be trusted from the cache only when every file feeding it is
    // present on disk at exactly the size and mtime recorded when it was hashed.
    private pieceUnchanged(index: number, cached: CheckedCache): boolean {
        for (const plan of this.plansForPiece(index)) {
            if (plan.file.length === 0) continue;
            const src = this.existingSource(plan);
            if (!src || src.mtimeMs === undefined) return false;
            const c = cached.files[plan.file.path.join("/")];
            if (!c || c.size !== src.size || c.mtimeMs !== src.mtimeMs) return false;
        }
        return true;
    }

    // True when an output file is physically on disk but its pieces don't all
    // verify against `have` — i.e. there's wrong/partial data in the user's
    // output files the UI should flag as corrupt rather than reporting a plain
    // empty/incomplete download. Judged against the verified bitfield, not the
    // file's size: a right-sized file full of garbage (0% verifying) is still
    // mismatched output, even though open() optimistically marked it finalized.
    hasMismatchedOutput(have: Bitfield): boolean {
        return this.filePlans.some((p) => p.existingFinalSize !== undefined && p.file.length > 0 && !this.fileComplete(p.file, have));
    }

    // Whether verification is reading the user's finished output files
    // ("output") or the in-progress temp copies ("temp"). Drives the UI's
    // "verify out" vs "verify tmp" distinction. "output" wins if any file is
    // backed by a real output file (complete or salvageable); only a torrent
    // whose data lives solely in temp copies reports "temp".
    get verifyTarget(): "output" | "temp" {
        for (const plan of this.filePlans) {
            if (plan.file.length === 0) continue;
            const src = this.existingSource(plan);
            if (src && src.path === plan.finalPath) return "output";
        }
        return "temp";
    }

    private async loadCheckedCache(): Promise<CheckedCache | undefined> {
        cacheStats.loads++;
        const raw = await readFile(this.checkedCachePath(), "utf8").catch(() => undefined);
        if (!raw) return undefined;
        try {
            const parsed = JSON.parse(raw) as CheckedCache;
            if (parsed.version !== CHECKED_CACHE_VERSION) return undefined;
            cacheStats.loadHits++;
            return parsed;
        } catch {
            return undefined;
        }
    }

    // Records every touched file that's physically present (size+mtime) alongside
    // the verified-piece bitfield. Missing files are simply omitted, so their
    // pieces re-hash next time while present files stay cached.
    private async writeCheckedCache(have: Bitfield): Promise<void> {
        const touched = this.computeTouchedFiles();
        const files: Record<string, { size: number; mtimeMs: number }> = {};
        for (const plan of this.filePlans) {
            if (!touched.has(plan.file)) continue;
            const src = this.existingSource(plan);
            if (!src || src.mtimeMs === undefined) continue;
            files[plan.file.path.join("/")] = { size: src.size, mtimeMs: src.mtimeMs };
        }
        const cache: CheckedCache = {
            version: CHECKED_CACHE_VERSION,
            pieceCount: this.meta.pieceHashes.length,
            files,
            have: Buffer.from(have.bytes).toString("base64"),
        };
        try {
            await mkdir(path.join(this.saveDir, CHECKED_CACHE_DIR), { recursive: true });
            await writeFile(this.checkedCachePath(), JSON.stringify(cache), "utf8");
            cacheStats.writes++;
        } catch (e) {
            cacheStats.writeFailures++;
            cacheStats.lastWriteError = e instanceof Error && e.message || String(e);
        }
    }

    private checkedCachePath(): string {
        return path.join(this.saveDir, CHECKED_CACHE_DIR, `${this.meta.infoHash.toString("hex")}.json`);
    }

    async readBlock(pieceIndex: number, begin: number, length: number): Promise<Buffer> {
        if (!this.opened) throw new Error("Storage not open");
        const pieceStart = pieceIndex * this.meta.pieceLength;
        return this.readAt(pieceStart + begin, length);
    }

    // SHA-1-check a single piece's bytes as they currently sit on disk (the
    // managed copy: finalized output, else temp). Used to re-confirm a piece is
    // still intact before serving it to a peer, so on-disk verification lives
    // only here and in verifyExistingPieces.
    async verifyPiece(index: number): Promise<boolean> {
        if (!this.opened) throw new Error("Storage not open");
        const data = await this.readBlock(index, 0, pieceLengthAt(this.meta, index));
        return crypto.createHash("sha1").update(data).digest().equals(this.meta.pieceHashes[index]);
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

    // "tempOnly" mode skips files that are already complete in place (importing
    // verified pieces only needs to fill the in-progress temp copy).
    private async writeAt(absoluteOffset: number, data: Buffer, mode?: "tempOnly"): Promise<void> {
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
            if (mode === "tempOnly" && plan.finalized) continue;
            const handle = await open(this.activePath(plan), fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
            try {
                await writeFully(handle, data, dataOffset, sliceLength, fileOffset);
                diskIO.bytesWritten += sliceLength;
            } finally {
                await handle.close();
            }
        }
    }

    // "active" reads the data we manage (final file when finalized, else temp)
    // and throws if a needed file isn't allocated. "existing" reads whatever is
    // physically on disk — the existing output file (clamped to its real size,
    // remaining bytes left as zeros) when present, else the temp file — and
    // never throws, so a scan can salvage partial/mismatched output.
    private async readAt(absoluteOffset: number, length: number, mode: "active" | "existing" = "active"): Promise<Buffer> {
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
            if (mode === "existing") {
                const src = this.existingSource(plan);
                if (!src || fileOffset >= src.limit) continue; // no data here → leave zeros
                const avail = Math.min(sliceLength, src.limit - fileOffset);
                const handle = await open(src.path, fsConstants.O_RDONLY).catch(() => undefined);
                if (!handle) continue;
                try {
                    diskIO.bytesRead += await readFully(handle, out, outOffset, avail, fileOffset);
                } finally {
                    await handle.close();
                }
                continue;
            }
            if (!plan.allocated) {
                throw new Error(`Read from unallocated file ${file.path.join("/")}`);
            }
            const handle = await open(this.activePath(plan), fsConstants.O_RDONLY);
            try {
                diskIO.bytesRead += await readFully(handle, out, outOffset, sliceLength, fileOffset);
            } finally {
                await handle.close();
            }
        }
        return out;
    }

    // The one place that decides which file physically backs a plan's bytes: the
    // final output file when present (clamped to its real size for salvage),
    // otherwise the allocated temp copy. Returns its read path + readable limit
    // and its on-disk identity (size + mtime) for cache keying. Everything that
    // touches existing on-disk data — reads, the verified-piece cache, and the
    // verify-target label — goes through here, so they can never disagree.
    private existingSource(plan: FilePlan): { path: string; limit: number; size: number; mtimeMs?: number } | undefined {
        if (plan.existingFinalSize !== undefined) {
            return { path: plan.finalPath, limit: plan.existingFinalSize, size: plan.existingFinalSize, mtimeMs: plan.existingFinalMtimeMs };
        }
        if (plan.allocated && plan.existingTempSize !== undefined) {
            return { path: plan.tempPath, limit: plan.file.length, size: plan.existingTempSize, mtimeMs: plan.existingTempMtimeMs };
        }
        return undefined;
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
