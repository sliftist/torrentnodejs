import { Worker } from "worker_threads";
import os from "os";

// Each file feeding the torrent's byte stream, plus where its bytes physically
// live right now (the final output file or a temp copy). srcPath undefined means
// no data is on disk for that file, so its range reads back as zeros.
export interface VerifyFile {
    offsetInTorrent: number;
    length: number;
    srcPath?: string;
    srcLimit: number;
}

export interface VerifyJob {
    files: VerifyFile[];
    pieceLength: number;
    totalLength: number;
    pieceCount: number;
    // Pieces to read, ascending. hashes holds their expected 20-byte SHA-1s in
    // the same order (concatenated), so position k pairs indices[k] with
    // hashes[k*20 .. k*20+20].
    indices: Int32Array;
    hashes: Uint8Array;
    readRunBytes: number;
    wantMismatch: boolean;
    // Disk-read cap for this worker, in bytes per second (0 = unlimited). The
    // pool injects it at dispatch from the global verify scan limit.
    maxBytesPerSec: number;
}

export interface VerifyResult {
    verified: Int32Array;
    mismatches: { index: number; computed: Buffer }[];
    bytesRead: number;
}

// The worker owns a torrent's whole verify pass: it opens the files, streams
// them in big sequential runs (one run read-ahead so the disk and the SHA-1
// core overlap), hashes every piece, and reports back only small messages — a
// throttled piece count and, at the end, the verified bitset. Doing the I/O in
// the worker is the whole point: handing raw file bytes back to the main thread
// per piece was slower than single-threaded, because the cross-thread copy cost
// more than the hash it saved.
const WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
const crypto = require("crypto");
const fs = require("fs").promises;

async function readFully(handle, buffer, offset, length, position) {
    let total = 0;
    while (total < length) {
        const { bytesRead } = await handle.read(buffer, offset + total, length - total, position + total);
        if (bytesRead === 0) break;
        total += bytesRead;
    }
    return total;
}

async function verify(id, job) {
    const { files, pieceLength, totalLength, pieceCount, indices, hashes, readRunBytes, wantMismatch, maxBytesPerSec } = job;
    const lastLen = totalLength - pieceLength * (pieceCount - 1);
    const lenAt = (i) => (i === pieceCount - 1) && lastLen || pieceLength;
    const piecesPerRun = Math.max(1, Math.floor(readRunBytes / pieceLength));

    // Coalesce consecutive indices into runs so a spinning disk streams instead
    // of seeking between every piece.
    const runs = [];
    for (let k = 0; k < indices.length; k++) {
        const idx = indices[k];
        const last = runs[runs.length - 1];
        if (last && idx === last[last.length - 1] + 1 && last.length < piecesPerRun) last.push(idx);
        else runs.push([idx]);
    }

    const handles = new Map();
    const openCached = (p) => {
        let h = handles.get(p);
        if (!h) {
            h = (async () => { try { return await fs.open(p, "r"); } catch { return undefined; } })();
            handles.set(p, h);
        }
        return h;
    };

    let bytesRead = 0;
    const readRun = async (run) => {
        const startOffset = run[0] * pieceLength;
        const endOffset = run[run.length - 1] * pieceLength + lenAt(run[run.length - 1]);
        const length = endOffset - startOffset;
        const out = Buffer.alloc(length);
        for (const f of files) {
            const fileEnd = f.offsetInTorrent + f.length;
            if (startOffset >= fileEnd) continue;
            if (startOffset + length <= f.offsetInTorrent) break;
            const readStart = Math.max(startOffset, f.offsetInTorrent);
            const readEnd = Math.min(startOffset + length, fileEnd);
            const fileOffset = readStart - f.offsetInTorrent;
            const outOffset = readStart - startOffset;
            const sliceLength = readEnd - readStart;
            if (!f.srcPath || fileOffset >= f.srcLimit) continue;
            const avail = Math.min(sliceLength, f.srcLimit - fileOffset);
            const handle = await openCached(f.srcPath);
            if (!handle) continue;
            bytesRead += await readFully(handle, out, outOffset, avail, fileOffset);
        }
        return out;
    };

    const verified = [];
    const mismatches = [];
    let piecesRead = 0;
    let lastPost = Date.now();
    const startTime = Date.now();
    let pos = 0;
    let prefetch = runs.length && readRun(runs[0]) || undefined;
    for (let r = 0; r < runs.length; r++) {
        const buf = await prefetch;
        prefetch = (r + 1 < runs.length) && readRun(runs[r + 1]) || undefined;
        const run = runs[r];
        if (buf) {
            const base = run[0] * pieceLength;
            for (let j = 0; j < run.length; j++) {
                const idx = run[j];
                const off = idx * pieceLength - base;
                const len = lenAt(idx);
                const digest = crypto.createHash("sha1").update(buf.subarray(off, off + len)).digest();
                const expected = hashes.subarray((pos + j) * 20, (pos + j) * 20 + 20);
                if (digest.equals(expected)) verified.push(idx);
                else if (wantMismatch) mismatches.push({ index: idx, computed: digest });
            }
        }
        pos += run.length;
        piecesRead += run.length;
        // Pace the disk reads: sleep until enough real time has passed for the
        // bytes read so far to stay under the cap. The one-run prefetch means a
        // sleep here also backpressures the next read.
        if (maxBytesPerSec > 0) {
            const wait = (bytesRead / maxBytesPerSec) * 1000 - (Date.now() - startTime);
            if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
        const now = Date.now();
        if (now - lastPost >= 250) {
            lastPost = now;
            parentPort.postMessage({ id, type: "progress", piecesRead, bytesRead });
        }
    }

    for (const pending of handles.values()) {
        const handle = await pending;
        if (handle) { try { await handle.close(); } catch {} }
    }

    const out = Int32Array.from(verified);
    parentPort.postMessage({ id, type: "done", verified: out, mismatches, bytesRead }, [out.buffer]);
}

parentPort.on("message", async (msg) => {
    try {
        await verify(msg.id, msg.job);
    } catch (e) {
        parentPort.postMessage({ id: msg.id, type: "error", message: String(e && e.message || e) });
    }
});
`;

interface Pending {
    resolve: (result: VerifyResult) => void;
    reject: (error: Error) => void;
    onProgress?: (progress: VerifyProgress) => void;
}

export interface VerifyProgress {
    piecesRead: number;
    bytesRead: number;
}

type WorkerMessage =
    | { id: number; type: "progress"; piecesRead: number; bytesRead: number }
    | { id: number; type: "done"; verified: Int32Array; mismatches: { index: number; computed: Buffer }[]; bytesRead: number }
    | { id: number; type: "error"; message: string };

// One worker per core verifies one torrent at a time; extra torrents queue.
// Workers are unref'd while idle so an idle pool never holds the process open,
// and ref'd whenever a job is in flight.
export class VerifyPool {
    private readonly workers: Worker[] = [];
    private readonly idle: Worker[] = [];
    private readonly queue: { id: number; job: VerifyJob; pending: Pending }[] = [];
    private readonly pending = new Map<number, Pending>();
    private nextId = 0;
    // Per-worker disk-read cap in bytes per second (0 = unlimited), injected into
    // every dispatched job. Set from the global verify scan limit.
    private maxBytesPerSec = 0;

    constructor(size = Math.max(1, os.cpus().length - 1)) {
        for (let i = 0; i < size; i++) {
            const worker = new Worker(WORKER_SOURCE, { eval: true });
            worker.unref();
            worker.on("message", (msg: WorkerMessage) => this.onMessage(worker, msg));
            this.workers.push(worker);
            this.idle.push(worker);
        }
    }

    private onMessage(worker: Worker, msg: WorkerMessage) {
        const entry = this.pending.get(msg.id);
        if (msg.type === "progress") {
            entry?.onProgress?.({ piecesRead: msg.piecesRead, bytesRead: msg.bytesRead });
            return;
        }
        this.pending.delete(msg.id);
        if (this.pending.size === 0) for (const w of this.workers) w.unref();
        const next = this.queue.shift();
        if (next) this.dispatch(worker, next.id, next.job, next.pending);
        else this.idle.push(worker);
        if (!entry) return;
        if (msg.type === "error") {
            entry.reject(new Error(msg.message));
            return;
        }
        entry.resolve({ verified: msg.verified, mismatches: msg.mismatches, bytesRead: msg.bytesRead });
    }

    setMaxBytesPerSec(maxBytesPerSec: number): void {
        this.maxBytesPerSec = Math.max(0, maxBytesPerSec);
    }

    private dispatch(worker: Worker, id: number, job: VerifyJob, pending: Pending) {
        if (this.pending.size === 0) for (const w of this.workers) w.ref();
        this.pending.set(id, pending);
        job.maxBytesPerSec = this.maxBytesPerSec;
        worker.postMessage({ id, job }, [job.indices.buffer as ArrayBuffer, job.hashes.buffer as ArrayBuffer]);
    }

    run(job: VerifyJob, onProgress?: (progress: VerifyProgress) => void): Promise<VerifyResult> {
        return new Promise<VerifyResult>((resolve, reject) => {
            const id = this.nextId++;
            const pending: Pending = { resolve, reject, onProgress };
            const worker = this.idle.pop();
            if (worker) this.dispatch(worker, id, job, pending);
            else this.queue.push({ id, job, pending });
        });
    }

    async terminate(): Promise<void> {
        await Promise.all(this.workers.map((w) => w.terminate()));
    }
}

// One pool shared by every torrent verify in the process, created on first use
// so a run that never verifies anything spawns no workers.
let shared: VerifyPool | undefined;
export function sharedVerifyPool(): VerifyPool {
    if (!shared) shared = new VerifyPool();
    return shared;
}
