import { open, mkdir, rename, rm, rmdir, readFile, writeFile, FileHandle } from "fs/promises";
import { constants as fsConstants } from "fs";
import crypto from "crypto";
import path from "path";
import { TorrentMeta, TorrentFile, pieceLengthAt } from "./torrentFile";
import { Bitfield } from "./bitfield";
import { tryStat, pathExists } from "./fsUtils";
import { sharedVerifyPool, VerifyJob } from "./verifyPool";

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
    // Stat of the final output file on disk, if any. Set even when its size
    // doesn't match the torrent's expected length — that's how we read and
    // salvage a partial or mismatched output file rather than reporting 0%.
    finalSize?: number;
    finalMtimeMs?: number;
    // Stat of the in-progress temp copy, set only once that file physically
    // exists on disk: a partial picked up at open() (a resumed download) or one
    // we allocated on the first write to it. Undefined means no temp file
    // exists, so a torrent we only scan (or haven't begun downloading) reserves
    // no space and has nothing temp-backed to read.
    tempSize?: number;
    tempMtimeMs?: number;
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

// Target size of a single sequential read during verification. The old loop
// read one piece per syscall (often just 256KB–1MB); on a spinning disk that
// means a seek/stall between every read. Coalescing adjacent pieces into reads
// this large lets the platter stream at full speed, which dominates HDD verify
// throughput. Two of these may be in memory at once (one hashing, one
// prefetching), so keep it modest.
const READ_RUN_BYTES = 16 * 1024 * 1024;

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
    private scanned = false;

    constructor(
        private readonly meta: TorrentMeta,
        private readonly saveDir: string,
        // If provided, files outside the touched set are NOT allocated.
        // A "touched" file is one that overlaps with the active piece selection.
        private readonly touchedPieces?: Set<number>,
    ) {}

    // Build the file plan (which torrent file maps to which output/temp path)
    // and nothing else: no disk I/O, no stats, no allocation. Cheap and always
    // safe to call, even for a multi-terabyte torrent whose data isn't present.
    // Learning what's on disk is scanDiskState(); creating temp files is the
    // lazy first-write in writeAt().
    async open(): Promise<void> {
        if (this.opened) return;
        this.opened = true;
        const tempBase = this.incompleteDir();
        const touchedFiles = this.computeTouchedFiles();
        for (const f of this.meta.files) {
            const finalPath = path.join(this.saveDir, ...f.path);
            const tempPath = this.joinSameFlavor(tempBase, f.path);
            const allocated = touchedFiles.has(f);
            this.filePlans.push({ file: f, finalPath, tempPath, allocated, finalized: false });
        }
    }

    // True if any of this torrent's bytes are already on disk: a finished (or
    // partial) output under the save dir, or an in-progress temp dir from an
    // earlier run. Pure existence primitive — storage answers "do these paths
    // exist?" and the caller decides what to do with the answer (e.g. skip the
    // verify scan for a torrent that hasn't been downloaded at all).
    async hasStoredData(): Promise<boolean> {
        const contentRoot = path.join(this.saveDir, this.meta.name);
        if (await pathExists(contentRoot)) return true;
        return pathExists(this.incompleteDir());
    }

    // Stat every file to record what's on disk: the size/mtime of any finished
    // output file (so we can verify or salvage it) and of any partial temp file
    // left by a previous run (so a resumed download picks up its progress).
    // Allocates nothing. Stats run with bounded concurrency so a many-file
    // torrent doesn't crawl through them one await at a time.
    async scanDiskState(): Promise<void> {
        if (!this.opened) throw new Error("Storage not open");
        if (this.scanned) return;
        this.scanned = true;
        // Don't stat files under a top-level directory that isn't there: a
        // torrent never downloaded has no temp dir, and one not yet written to
        // the save dir has no content root. Every per-file stat under a missing
        // dir is a guaranteed ENOENT, so for a many-file torrent these two
        // checks replace hundreds of thousands of pointless syscalls.
        const contentExists = await pathExists(path.join(this.saveDir, this.meta.name));
        const tempExists = await pathExists(this.incompleteDir());
        const statPlan = async (plan: FilePlan) => {
            const finalStat = contentExists && await tryStat(plan.finalPath) || undefined;
            if (finalStat) {
                plan.finalSize = finalStat.size;
                plan.finalMtimeMs = finalStat.mtimeMs;
            }
            if (!plan.allocated) return;
            // A right-sized final file is already complete: read it in place.
            if (finalStat && finalStat.size === plan.file.length) {
                plan.finalized = true;
                return;
            }
            // No temp dir means nothing was ever downloaded here, so skip the
            // per-file temp stats entirely.
            if (!tempExists) return;
            // Pick up a partial temp file left by a previous run so a resumed
            // download verifies its existing progress.
            const tempStat = await tryStat(plan.tempPath);
            if (tempStat) {
                plan.tempSize = tempStat.size;
                plan.tempMtimeMs = tempStat.mtimeMs;
            }
        };
        let next = 0;
        const worker = async () => {
            while (next < this.filePlans.length) await statPlan(this.filePlans[next++]);
        };
        await Promise.all(Array.from({ length: Math.min(128, this.filePlans.length) }, worker));
    }

    async close(): Promise<void> {
        this.filePlans = [];
        this.opened = false;
        this.scanned = false;
    }

    // Erase everything this torrent owns on disk, whatever state it's in: the
    // in-progress temp directory (partial downloads live here), the verified-piece
    // cache, and the finished/partial output files — then prune any output
    // directories left empty. A primitive: the caller decides when a torrent
    // should be deleted; storage just knows where all its bytes live.
    async deleteOnDiskData(): Promise<void> {
        await this.open();
        try { await rm(this.incompleteDir(), { recursive: true, force: true }); } catch {}
        try { await rm(this.checkedCachePath(), { force: true }); } catch {}
        const dirs = new Set<string>();
        for (const plan of this.filePlans) {
            try { await rm(plan.finalPath, { force: true }); } catch {}
            let dir = path.dirname(plan.finalPath);
            while (dir.length > this.saveDir.length && dir.startsWith(this.saveDir)) {
                dirs.add(dir);
                dir = path.dirname(dir);
            }
        }
        // Deepest first so a parent is only pruned after its children. rmdir
        // throws on a non-empty dir, which we ignore — shared dirs stay put.
        for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
            try { await rmdir(dir); } catch {}
        }
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
    async finalizeFiles(have: Bitfield, completedPiece?: number): Promise<void> {
        if (!this.opened) throw new Error("Storage not open");
        // A single completed piece can only finish the file(s) it overlaps, so the
        // per-piece path narrows to those instead of re-scanning every file.
        const plans = completedPiece === undefined ? this.filePlans : this.plansForPiece(completedPiece);
        for (const plan of plans) {
            if (!plan.allocated || plan.finalized) continue;
            if (!this.fileComplete(plan.file, have)) continue;
            // Claim the rename synchronously, before any await, so concurrent
            // per-piece finalize calls don't both try to rename the same temp
            // file (the second would ENOENT after the first moved it).
            plan.finalized = true;
            await mkdir(path.dirname(plan.finalPath), { recursive: true });
            await rename(plan.tempPath, plan.finalPath);
        }
        if (this.filePlans.every((p) => !p.allocated || p.finalized)) {
            try {
                await rm(this.incompleteDir(), { recursive: true, force: true });
            } catch {}
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
        // onProgress reports how many of the pieces that actually need reading
        // have been hashed so far (cache-trusted and unbacked pieces are
        // instant, so they're excluded from the total) — used to show live scan
        // progress for the slow, disk-bound part of a verify.
        config?: {
            importToTemp?: boolean;
            onMismatch?: (info: { index: number; computed: Buffer; expected: Buffer }) => void;
            onProgress?: (info: { piecesRead: number; piecesToRead: number; bytesRead: number; bytesToRead: number }) => void;
        },
    ): Promise<Bitfield> {
        if (!this.opened) throw new Error("Storage not open");
        // Verifying needs to know what's on disk; scanDiskState is idempotent, so
        // callers that already scanned (e.g. the seed path) pay nothing.
        await this.scanDiskState();

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

        // Decide which pieces actually need reading. Cache-trusted pieces are
        // recorded with no I/O; pieces with no file behind them are simply
        // missing (hashing a zero buffer could never match), so they're skipped
        // — that's what makes a torrent whose data isn't on disk verify instantly
        // instead of hashing terabytes of zeros.
        const toRead: number[] = [];
        for (const i of toCheck) {
            if (i < 0 || i >= this.meta.pieceHashes.length) continue;
            if (cachedHave && cached && this.pieceUnchanged(i, cached)) {
                if (cachedHave.get(i)) result.set(i);
                continue;
            }
            if (!this.pieceBacked(i)) continue;
            toRead.push(i);
        }
        toRead.sort((a, b) => a - b);

        let bytesToRead = 0;
        for (const i of toRead) bytesToRead += pieceLengthAt(this.meta, i);

        config?.onProgress?.({ piecesRead: 0, piecesToRead: toRead.length, bytesRead: 0, bytesToRead });
        if (toRead.length) {
            // Hand the whole torrent's read+verify to one worker: it opens the
            // files, streams them in big sequential runs, and SHA-1s every piece
            // itself. Splitting per torrent (not per piece) means one worker owns
            // a torrent's disk I/O end to end, so N concurrent scans use N cores
            // without shuttling file bytes across threads — the per-piece handoff
            // was slower than single-threaded. The worker reads from whatever
            // currently backs each file (final output or temp copy), resolved
            // here so the cache/decision logic stays on the main thread.
            // Built lazily by the pool at dispatch (not here), so a torrent
            // waiting its turn behind the concurrentScans cap doesn't hold its
            // index/hash arrays in memory while queued.
            const buildJob = (): VerifyJob => {
                const files = this.filePlans.map((plan) => {
                    const src = this.existingSource(plan);
                    return {
                        offsetInTorrent: plan.file.offsetInTorrent,
                        length: plan.file.length,
                        srcPath: src?.path,
                        srcLimit: src?.limit ?? 0,
                    };
                });
                const indices = Int32Array.from(toRead);
                const hashes = new Uint8Array(toRead.length * 20);
                for (let k = 0; k < toRead.length; k++) hashes.set(this.meta.pieceHashes[toRead[k]], k * 20);
                return {
                    files,
                    pieceLength: this.meta.pieceLength,
                    totalLength: this.meta.totalLength,
                    pieceCount: this.meta.pieceHashes.length,
                    indices,
                    hashes,
                    readRunBytes: READ_RUN_BYTES,
                    wantMismatch: Boolean(config?.onMismatch),
                    // Injected by the pool at dispatch from the global scan cap.
                    maxBytesPerSec: 0,
                };
            };
            // The worker reports bytes read so far as it streams; fold each delta
            // into the global counter live so the UI's read-rate (and the verify
            // ETA derived from it) tracks a long scan instead of jumping only when
            // the whole torrent finishes.
            let reportedBytes = 0;
            const { verified, mismatches, bytesRead } = await sharedVerifyPool().run(
                buildJob,
                (progress) => {
                    diskIO.bytesRead += progress.bytesRead - reportedBytes;
                    reportedBytes = progress.bytesRead;
                    config?.onProgress?.({ piecesRead: progress.piecesRead, piecesToRead: toRead.length, bytesRead: progress.bytesRead, bytesToRead });
                },
            );
            diskIO.bytesRead += bytesRead - reportedBytes;
            for (const i of verified) result.set(i);
            if (config?.onMismatch) {
                for (const m of mismatches) {
                    config.onMismatch({ index: m.index, computed: Buffer.from(m.computed), expected: this.meta.pieceHashes[m.index] });
                }
            }
            config?.onProgress?.({ piecesRead: toRead.length, piecesToRead: toRead.length, bytesRead, bytesToRead });
        }

        if (config?.importToTemp) {
            const valid: { index: number; data: Buffer }[] = [];
            // A right-sized file we optimistically read in place might still turn
            // out to be the wrong content (failed verification). Demote it to the
            // temp copy so the original output is left untouched until the
            // re-download completes and renames over it.
            for (const plan of this.filePlans) {
                if (!plan.finalized || this.fileComplete(plan.file, result)) continue;
                plan.finalized = false;
                if (plan.finalSize === undefined) plan.finalSize = plan.file.length;
                await this.allocate(plan.tempPath, plan.file.length);
                plan.tempSize = plan.file.length;
            }
            // The verify pass runs in a worker and keeps no bytes, so every good
            // piece that now belongs to a demoted (temp-backed) file has its bytes
            // read here on demand and copied into the temp file.
            for (const i of toCheck) {
                if (!result.get(i)) continue;
                if (this.plansForPiece(i).every((p) => p.finalized)) continue;
                let data: Buffer | undefined;
                try {
                    data = await this.readAt(i * this.meta.pieceLength, pieceLengthAt(this.meta, i), "existing");
                } catch {}
                if (data) valid.push({ index: i, data });
            }
            for (const { index, data } of valid) {
                await this.writeAt(index * this.meta.pieceLength, data, "tempOnly");
            }
        }

        if (!config?.onMismatch) await this.writeCheckedCache(result);
        return result;
    }

    // FilePlans whose byte range overlaps piece `index`. filePlans are contiguous
    // and sorted by offset, so binary-search to the first overlapping file and
    // walk forward — O(log files + overlap) instead of scanning every file per
    // piece, which was quadratic on huge multi-file torrents during verify.
    private plansForPiece(index: number): FilePlan[] {
        const start = index * this.meta.pieceLength;
        const end = start + pieceLengthAt(this.meta, index);
        let lo = 0;
        let hi = this.filePlans.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const plan = this.filePlans[mid];
            if (plan.file.offsetInTorrent + plan.file.length > start) hi = mid;
            else lo = mid + 1;
        }
        const out: FilePlan[] = [];
        for (let i = lo; i < this.filePlans.length; i++) {
            const plan = this.filePlans[i];
            if (plan.file.offsetInTorrent >= end) break;
            out.push(plan);
        }
        return out;
    }

    // True only if every byte of this piece is backed by a file that physically
    // exists on disk and is long enough to cover it. When any overlapping file is
    // absent (or too short), the piece can't possibly hash correctly, so there's
    // no point reading or hashing it — it's missing, not corrupt.
    private pieceBacked(index: number): boolean {
        const end = index * this.meta.pieceLength + pieceLengthAt(this.meta, index);
        for (const plan of this.plansForPiece(index)) {
            if (plan.file.length === 0) continue;
            const src = this.existingSource(plan);
            if (!src) return false;
            const fileEnd = plan.file.offsetInTorrent + plan.file.length;
            const fileOffsetEnd = Math.min(end, fileEnd) - plan.file.offsetInTorrent;
            if (fileOffsetEnd > src.limit) return false;
        }
        return true;
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
        return this.filePlans.some((p) => p.finalSize !== undefined && p.file.length > 0 && !this.fileComplete(p.file, have));
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
        let raw: string | undefined;
        try {
            raw = await readFile(this.checkedCachePath(), "utf8");
        } catch {}
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
            // First write to this temp file: allocate it now, reserving its full
            // (sparse) size. This is the only place temp files are created, so a
            // file we never download never reserves space — and once it exists it
            // becomes the backing source for later reads/verify.
            if (!plan.finalized && plan.tempSize === undefined) {
                await this.allocate(plan.tempPath, plan.file.length);
                plan.tempSize = plan.file.length;
            }
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
    // Open a file read-only, reusing a previously-opened handle from `cache` when
    // given one (so a verify pass opens each file once instead of per piece). The
    // cache stores the in-flight open *promise*, so concurrent callers for the
    // same path share one handle rather than each opening (and leaking) their own.
    private async tryOpenReadOnly(p: string): Promise<FileHandle | undefined> {
        try {
            return await open(p, fsConstants.O_RDONLY);
        } catch {
            return undefined;
        }
    }

    private openRead(p: string, cache?: Map<string, Promise<FileHandle | undefined>>): Promise<FileHandle | undefined> {
        if (!cache) return this.tryOpenReadOnly(p);
        let pending = cache.get(p);
        if (!pending) {
            pending = this.tryOpenReadOnly(p);
            cache.set(p, pending);
        }
        return pending;
    }

    private async readAt(absoluteOffset: number, length: number, mode: "active" | "existing" = "active", handles?: Map<string, Promise<FileHandle | undefined>>): Promise<Buffer> {
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
                const handle = await this.openRead(src.path, handles);
                if (!handle) continue;
                try {
                    diskIO.bytesRead += await readFully(handle, out, outOffset, avail, fileOffset);
                } finally {
                    // Leave cached handles open; the verify pass closes them once.
                    if (!handles) await handle.close();
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
        if (plan.finalSize !== undefined) {
            return { path: plan.finalPath, limit: plan.finalSize, size: plan.finalSize, mtimeMs: plan.finalMtimeMs };
        }
        if (plan.allocated && plan.tempSize !== undefined) {
            return { path: plan.tempPath, limit: plan.file.length, size: plan.tempSize, mtimeMs: plan.tempMtimeMs };
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
