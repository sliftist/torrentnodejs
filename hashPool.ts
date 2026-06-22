import { Worker } from "worker_threads";
import os from "os";

// Inlined worker: SHA-1 a buffer handed over from the main thread and post the
// digest back. Run as an eval worker so there's no separate build artifact to
// keep in sync with under typenode.
const WORKER_SOURCE = `
const { parentPort } = require("worker_threads");
const crypto = require("crypto");
parentPort.on("message", (msg) => {
    const digest = crypto.createHash("sha1").update(msg.data).digest();
    parentPort.postMessage({ id: msg.id, digest }, [digest.buffer]);
});
`;

// SHA-1 verification is otherwise single-threaded, so on a fast disk it becomes
// the bottleneck for a multi-terabyte scan — one core pegged while the array
// sits idle. This pool spreads piece hashing across every core. Workers are
// unref'd whenever no hash is outstanding so an idle pool never holds the
// process open, and ref'd again the moment work is dispatched.
export class HashPool {
    private readonly workers: Worker[] = [];
    private readonly idle: Worker[] = [];
    private readonly waiting: ((worker: Worker) => void)[] = [];
    private readonly pending = new Map<number, (digest: Buffer) => void>();
    private nextId = 0;

    constructor(size = Math.max(1, os.cpus().length - 1)) {
        for (let i = 0; i < size; i++) {
            const worker = new Worker(WORKER_SOURCE, { eval: true });
            worker.unref();
            worker.on("message", (msg: { id: number; digest: ArrayBuffer }) => {
                const resolve = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (this.pending.size === 0) for (const w of this.workers) w.unref();
                const next = this.waiting.shift();
                if (next) next(worker);
                else this.idle.push(worker);
                resolve?.(Buffer.from(msg.digest));
            });
            this.workers.push(worker);
            this.idle.push(worker);
        }
    }

    async hash(data: Buffer): Promise<Buffer> {
        const worker = await this.take();
        const id = this.nextId++;
        // Copy into a standalone, non-pooled buffer so it can be transferred
        // (zero-copy) to the worker. allocUnsafeSlow avoids Buffer's shared pool,
        // whose ArrayBuffer must never be detached out from under sibling pieces
        // (the last piece of a torrent is often small enough to be pooled).
        const copy = Buffer.allocUnsafeSlow(data.length);
        data.copy(copy);
        return new Promise<Buffer>((resolve) => {
            if (this.pending.size === 0) for (const w of this.workers) w.ref();
            this.pending.set(id, resolve);
            worker.postMessage({ id, data: copy }, [copy.buffer]);
        });
    }

    private take(): Promise<Worker> {
        const ready = this.idle.pop();
        if (ready) return Promise.resolve(ready);
        return new Promise<Worker>((resolve) => this.waiting.push(resolve));
    }

    async terminate(): Promise<void> {
        await Promise.all(this.workers.map((w) => w.terminate()));
    }
}

// One pool shared by every torrent verify in the process, created on first use
// so a run that never verifies anything spawns no workers.
let shared: HashPool | undefined;
export function sharedHashPool(): HashPool {
    if (!shared) shared = new HashPool();
    return shared;
}
