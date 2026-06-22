import crypto from "crypto";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "fs/promises";
import { encode } from "../bencode";
import { parseTorrentFile } from "../torrentFile";
import { TorrentManager } from "../cli/torrentManager";
import { DEFAULT_SCHEDULER } from "../cli/config";
import { NodeTransport } from "../transport";
import { diskIO, cacheStats } from "../storage";

// Standalone, no-network reproduction of "scan" run mode. Generates torrents,
// writes their data to a downloads dir, then runs the real TorrentManager in
// scan mode. The orchestrator (no args) lays out the dir and runs TWO scans in
// SEPARATE child processes — a faithful "verify, kill, restart" — and checks
// that the second process is served from the on-disk verified-piece cache
// instead of re-hashing. Each child prints its own per-pass diskIO so the
// cross-process cache is what's actually measured.
//
//   yarn typenode scripts/checkHarness.ts                          # synthetic, both passes
//   yarn typenode scripts/checkHarness.ts real <downloads> <sources>  # two passes over REAL dirs
//   yarn typenode scripts/checkHarness.ts scan <downloads> <sources>  # one pass (internal)

const PIECE_LENGTH = 32 * 1024;
const LISTEN_PORT = 6899;

type Spec = {
    name: string;
    kind: "complete" | "corruptOnePiece" | "missing" | "truncated" | "wrongContent" | "tempPartial" | "multiComplete";
    pieces: number;
};

const SPECS: Spec[] = [
    ...Array.from({ length: 40 }, (_, i) => ({ name: `complete-${i}`, kind: "complete" as const, pieces: 8 })),
    ...Array.from({ length: 10 }, (_, i) => ({ name: `multi-${i}`, kind: "multiComplete" as const, pieces: 8 })),
    { name: "corrupt-a", kind: "corruptOnePiece", pieces: 8 },
    { name: "missing-a", kind: "missing", pieces: 8 },
    { name: "truncated-a", kind: "truncated", pieces: 8 },
    { name: "wrongcontent-a", kind: "wrongContent", pieces: 8 },
    { name: "temppartial-a", kind: "tempPartial", pieces: 8 },
];

function delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

// Build a single- or multi-file torrent buffer over `data`. Multi-file splits
// `data` into two files at a piece boundary so a piece can straddle the seam.
function buildTorrentBuffer(name: string, data: Buffer, multi: boolean): Buffer {
    const hashes: Buffer[] = [];
    for (let off = 0; off < data.length; off += PIECE_LENGTH) {
        hashes.push(crypto.createHash("sha1").update(data.subarray(off, Math.min(off + PIECE_LENGTH, data.length))).digest());
    }
    const info: Record<string, unknown> = {
        name: Buffer.from(name),
        "piece length": PIECE_LENGTH,
        pieces: Buffer.concat(hashes),
    };
    if (multi) {
        const split = Math.floor(data.length / 2);
        info["files"] = [
            { length: split, path: [Buffer.from("part1.bin")] },
            { length: data.length - split, path: [Buffer.from("sub"), Buffer.from("part2.bin")] },
        ];
    } else {
        info["length"] = data.length;
    }
    return encode({ announce: Buffer.from("http://tracker.invalid/announce"), info } as never);
}

async function setup(root: string): Promise<void> {
    const sources = path.join(root, "sources");
    const downloads = path.join(root, "downloads");
    await mkdir(sources, { recursive: true });
    await mkdir(downloads, { recursive: true });

    for (const spec of SPECS) {
        const data = crypto.randomBytes(PIECE_LENGTH * spec.pieces - 13);
        const multi = spec.kind === "multiComplete";
        const torrentPath = path.join(sources, `${spec.name}.torrent`);
        await writeFile(torrentPath, buildTorrentBuffer(spec.name, data, multi));

        if (spec.kind === "missing") continue;
        if (spec.kind === "multiComplete") {
            const split = Math.floor(data.length / 2);
            await mkdir(path.join(downloads, spec.name, "sub"), { recursive: true });
            await writeFile(path.join(downloads, spec.name, "part1.bin"), data.subarray(0, split));
            await writeFile(path.join(downloads, spec.name, "sub", "part2.bin"), data.subarray(split));
            continue;
        }
        if (spec.kind === "tempPartial") {
            const meta = await parseTorrentFile(torrentPath);
            const tempDir = path.join(downloads, ".bittorrent-incomplete", meta.infoHash.toString("hex"));
            await mkdir(tempDir, { recursive: true });
            const temp = Buffer.alloc(data.length);
            data.copy(temp, 0, 0, PIECE_LENGTH * 4);
            await writeFile(path.join(tempDir, spec.name), temp);
            continue;
        }
        let onDisk = Buffer.from(data);
        if (spec.kind === "corruptOnePiece") onDisk.fill(0xff, PIECE_LENGTH * 2, PIECE_LENGTH * 3);
        if (spec.kind === "truncated") onDisk = onDisk.subarray(0, onDisk.length - PIECE_LENGTH * 2);
        if (spec.kind === "wrongContent") onDisk = crypto.randomBytes(data.length);
        await writeFile(path.join(downloads, spec.name), onDisk);
    }
}

// One scan pass: bring the manager up in scan mode, add every torrent, wait
// until none are still pending verification, then print results + bytes read.
async function scanPass(downloads: string, sources: string): Promise<void> {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "bt-check-state-"));
    const manager = new TorrentManager({
        transport: new NodeTransport(),
        downloadDir: downloads,
        scheduler: { ...DEFAULT_SCHEDULER, watchIntervalMs: 200 },
        listenPort: LISTEN_PORT,
        stateDir,
        mode: "scan",
    });
    await manager.start();
    let added = 0;
    for (const f of await readdir(sources)) {
        if (f.endsWith(".torrent")) { await manager.addSourceFile(path.join(sources, f)); added++; }
    }

    const pending = new Set(["unverified", "verifyOut", "verifyTmp", "queued"]);
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
        const views = manager.views();
        if (views.length >= added && views.every((v) => !pending.has(v.state))) break;
        await delay(200);
    }

    const views = [...manager.views()].sort((a, b) => a.name.localeCompare(b.name));
    await manager.stop();
    await rm(stateDir, { recursive: true, force: true });

    for (const v of views) {
        console.log(`ROW\t${v.name}\t${v.state}\t${(v.progress * 100).toFixed(1)}`);
    }
    console.log(`BYTES_READ\t${diskIO.bytesRead}`);
    console.log(`CACHE\t${cacheStats.writes}\t${cacheStats.writeFailures}\t${cacheStats.loads}\t${cacheStats.loadHits}\t${cacheStats.lastWriteError}`);
}

type CacheCounters = { writes: number; writeFailures: number; loads: number; loadHits: number; lastWriteError: string };
type ChildResult = { rows: { name: string; state: string; progress: number }[]; bytesRead: number; cache: CacheCounters; raw: string };

function runChild(downloads: string, sources: string): Promise<ChildResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["-r", require.resolve("typenode"), __filename, "scan", downloads, sources], {
            stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (c) => { out += c.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) return reject(new Error(`scan child exited ${code}`));
            const rows: { name: string; state: string; progress: number }[] = [];
            let bytesRead = 0;
            let cache: CacheCounters = { writes: 0, writeFailures: 0, loads: 0, loadHits: 0, lastWriteError: "" };
            for (const line of out.split("\n")) {
                const parts = line.split("\t");
                if (parts[0] === "ROW") rows.push({ name: parts[1], state: parts[2], progress: parseFloat(parts[3]) });
                if (parts[0] === "BYTES_READ") bytesRead = parseInt(parts[1], 10);
                if (parts[0] === "CACHE") cache = { writes: parseInt(parts[1], 10), writeFailures: parseInt(parts[2], 10), loads: parseInt(parts[3], 10), loadHits: parseInt(parts[4], 10), lastWriteError: parts[5] || "" };
            }
            resolve({ rows, bytesRead, cache, raw: out });
        });
    });
}

function printRows(label: string, result: ChildResult) {
    console.log(`\n=== ${label} ===`);
    for (const r of result.rows) {
        console.log(`  ${r.name.padEnd(14)} state=${r.state.padEnd(12)} progress=${r.progress.toFixed(1).padStart(5)}%`);
    }
    console.log(`  -> bytesRead this pass: ${(result.bytesRead / 1024).toFixed(1)} KiB`);
    const c = result.cache;
    console.log(`  -> cache: writes=${c.writes} writeFailures=${c.writeFailures} loads=${c.loads} loadHits=${c.loadHits}${c.lastWriteError && `  lastWriteError="${c.lastWriteError}"` || ""}`);
}

async function twoPassVerdict(downloads: string, sources: string, checkStates: boolean): Promise<void> {
    const first = await runChild(downloads, sources);
    printRows("FIRST SCAN (cold, separate process)", first);
    const second = await runChild(downloads, sources);
    printRows("SECOND SCAN (separate process, should hit cache)", second);

    console.log("\n--- cache verdict ---");
    let ratio = 1;
    if (first.bytesRead > 0) ratio = second.bytesRead / first.bytesRead;
    console.log(`  first=${(first.bytesRead / 1024 / 1024).toFixed(2)} MiB  second=${(second.bytesRead / 1024 / 1024).toFixed(2)} MiB  ratio=${(ratio * 100).toFixed(1)}%`);
    console.log(ratio > 0.1 && "  ✗ CACHE NOT WORKING: second scan re-read most of the data." || "  ✓ cache working: second scan barely touched disk.");
    if (second.cache.writeFailures > 0 || first.cache.writeFailures > 0) {
        console.log(`  ! cache writes FAILED (first=${first.cache.writeFailures} second=${second.cache.writeFailures}) — last error: ${second.cache.lastWriteError || first.cache.lastWriteError}`);
    }

    if (!checkStates) return;
    console.log("\n--- state sanity ---");
    let wrong = 0;
    for (const r of second.rows) {
        const spec = SPECS.find((s) => s.name === r.name);
        if (!spec) continue;
        const dataInOutput = spec.kind !== "missing" && spec.kind !== "tempPartial";
        if (dataInOutput && r.progress < 100 && r.state === "checked") {
            console.log(`  ✗ ${r.name}: output data present but state="checked" (should be corrupted)`);
            wrong++;
        }
    }
    if (wrong === 0) console.log("  ✓ all output-present-but-incomplete torrents reported as corrupted");
}

async function orchestrate(): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "bt-check-harness-"));
    try {
        await setup(root);
        await twoPassVerdict(path.join(root, "downloads"), path.join(root, "sources"), true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

async function main() {
    const cmd = process.argv[2];
    if (cmd === "scan") {
        await scanPass(process.argv[3], process.argv[4]);
        return;
    }
    if (cmd === "real") {
        const downloads = process.argv[3];
        const sources = process.argv[4];
        if (!downloads || !sources) throw new Error("Usage: checkHarness.ts real <downloadsDir> <sourcesDir>");
        await twoPassVerdict(downloads, sources, false);
        return;
    }
    await orchestrate();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
