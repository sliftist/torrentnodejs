import { mkdir, writeFile, readdir, readFile } from "fs/promises";
import path from "path";
import { parseTorrentBuffer, TorrentMeta } from "../torrentFile";

// Builds a large corpus of legal (.torrent) files for stress-testing the
// client. Every torrent is validated with our own parser and is only kept if
// it has at least one HTTP/UDP tracker — we are tracker-only (no DHT/PEX), so
// magnet/wss-only torrents would be undownloadable.
//
//   yarn fetch-corpus [dir] [count] [gigabytes] [seed]
//
// Defaults: ./test-corpus, 1000 torrents, 100 GB, random seed. Stops at
// whichever cap is hit first. Re-running is safe: existing .torrent files are
// skipped, so an interrupted run resumes.
//
// Each run shuffles its traversal of the (most-downloaded) pool of each
// collection using the seed, so two runs — or two output directories — get
// different torrents instead of the same top-of-the-list items every time.
// The seed is printed; pass it back as the 4th arg to reproduce a set exactly.
//
// Note on the count/bytes balance: these collections range from KB-sized texts
// to GB-sized concerts. The draw order below is weighted toward smaller items
// so the two caps fill at a similar pace, but the exact split depends on live
// item sizes — raise the GB cap to favor count, lower it to favor data volume.

const DEFAULT_DIR = "test-corpus";
const DEFAULT_COUNT = 1000;
const DEFAULT_GIB = 100;
const IA_PAGE_ROWS = 100;
// We only shuffle within the top N pages (by download count) of each
// collection so the picks stay reasonably well-seeded, while still differing
// run to run. N*IA_PAGE_ROWS items per collection make up the draw pool.
const POPULAR_PAGES = 50;
const FETCH_TIMEOUT_MS = 30000;
const GIB = 1024 * 1024 * 1024;

// Archive.org collections that are unambiguously free to redistribute (public
// domain or Creative Commons).
const IA_COLLECTIONS = [
    "gutenberg",         // public-domain texts (tiny)
    "librivoxaudio",     // public-domain audiobooks (medium)
    "opensource_audio",  // CC audio (small/medium)
    "opensource_movies", // CC movies (medium/large)
    "prelinger",         // Prelinger public-domain films (large)
    "etree",             // Live Music Archive — legal tradeable concerts (large)
];

// One round of draws. Smaller-item collections repeat so a handful of GB-sized
// concerts don't eat the whole byte budget before the count target is met.
const IA_DRAW_ORDER = [
    "gutenberg", "librivoxaudio", "opensource_audio", "opensource_movies",
    "gutenberg", "librivoxaudio", "opensource_audio", "prelinger",
    "gutenberg", "librivoxaudio", "etree",
];

// High-seed torrents that round out swarm health. Release URLs age out over
// time; failures here are non-fatal since the archive loop carries the count.
const CURATED_URLS = [
    "https://webtorrent.io/torrents/big-buck-bunny.torrent",
    "https://webtorrent.io/torrents/sintel.torrent",
    "https://webtorrent.io/torrents/tears-of-steel.torrent",
    "https://webtorrent.io/torrents/cosmos-laundromat.torrent",
    "https://webtorrent.io/torrents/wired-cd.torrent",
];

interface IaSearchResponse {
    response: { numFound: number; docs: { identifier: string }[] };
}

interface CorpusState {
    dir: string;
    targetCount: number;
    targetBytes: number;
    seenHashes: Set<string>;
    count: number;
    bytes: number;
}

// Lazily walks a shuffled set of pages of one archive.org collection, yielding
// identifiers in shuffled order.
interface CollectionCursor {
    collection: string;
    pageQueue: number[];
    docs: { identifier: string }[];
    idx: number;
    done: boolean;
}

async function main() {
    const dir = path.resolve(process.argv[2] || DEFAULT_DIR);
    const targetCount = parseInt(process.argv[3] || String(DEFAULT_COUNT), 10);
    const targetBytes = Math.round(parseFloat(process.argv[4] || String(DEFAULT_GIB)) * GIB);
    let seed = Date.now() >>> 0;
    if (process.argv[5]) seed = parseInt(process.argv[5], 10) >>> 0;
    const rng = makeRng(seed);
    await mkdir(dir, { recursive: true });

    const state: CorpusState = { dir, targetCount, targetBytes, seenHashes: new Set(), count: 0, bytes: 0 };
    await indexExisting(state);
    console.log(`Target: ${targetCount} torrents / ${(targetBytes / GIB).toFixed(0)} GB into ${dir}`);
    console.log(`Seed: ${seed} (pass as 4th arg to reproduce this exact set)`);
    console.log(`Already present: ${state.count} torrents, ${(state.bytes / GIB).toFixed(2)} GB\n`);

    // Curated high-seed list first.
    for (const url of CURATED_URLS) {
        if (capReached(state)) break;
        await tryAddFromUrl(state, url, path.basename(new URL(url).pathname));
    }

    // Archive.org, weighted round-robin one item at a time. Each collection
    // walks a shuffled subset of its most-downloaded pages.
    const cursors = new Map<string, CollectionCursor>();
    for (const col of IA_COLLECTIONS) {
        const pageQueue = shuffle(range(1, POPULAR_PAGES), rng);
        cursors.set(col, { collection: col, pageQueue, docs: [], idx: 0, done: false });
    }

    while (!capReached(state) && [...cursors.values()].some((c) => !exhausted(c))) {
        for (const col of IA_DRAW_ORDER) {
            if (capReached(state)) break;
            const cursor = cursors.get(col);
            if (!cursor) continue;
            const id = await nextIdentifier(cursor, rng);
            if (!id) continue;
            const url = `https://archive.org/download/${id}/${id}_archive.torrent`;
            await tryAddFromUrl(state, url, `${sanitize(id)}.torrent`);
        }
    }

    console.log(`\nDone. Corpus now holds ${state.count} torrents, ${(state.bytes / GIB).toFixed(2)} GB in ${dir}`);
    console.log(`Add it as a watched source in the CLI (paste the path), or: yarn scan`);
    process.exit(0);
}

function capReached(s: CorpusState): boolean {
    return s.count >= s.targetCount || s.bytes >= s.targetBytes;
}

function exhausted(c: CollectionCursor): boolean {
    return c.done && c.idx >= c.docs.length;
}

// Count what's already on disk so re-runs resume instead of re-downloading.
async function indexExisting(s: CorpusState): Promise<void> {
    const entries = await readdir(s.dir).catch(() => [] as string[]);
    for (const name of entries) {
        if (!name.toLowerCase().endsWith(".torrent")) continue;
        try {
            const meta = parseTorrentBuffer(await readFile(path.join(s.dir, name)));
            const hash = meta.infoHash.toString("hex");
            if (s.seenHashes.has(hash)) continue;
            s.seenHashes.add(hash);
            s.count++;
            s.bytes += meta.totalLength;
        } catch {
            // Unparseable leftover; ignore.
        }
    }
}

async function nextIdentifier(c: CollectionCursor, rng: () => number): Promise<string | undefined> {
    while (true) {
        if (c.idx < c.docs.length) return c.docs[c.idx++].identifier;
        const page = c.pageQueue.shift();
        if (page === undefined) { c.done = true; return undefined; }
        const docs = await fetchArchivePage(c.collection, page);
        if (docs.length === 0) continue;
        c.docs = shuffle(docs, rng);
        c.idx = 0;
    }
}

async function fetchArchivePage(collection: string, page: number): Promise<{ identifier: string }[]> {
    const params = new URLSearchParams();
    // Exclude collection hub pages (e.g. an artist's etree page), whose
    // "_archive.torrent" is just a near-empty metadata bundle.
    params.set("q", `collection:${collection} AND NOT mediatype:collection`);
    params.append("fl[]", "identifier");
    params.append("sort[]", "downloads desc");
    params.set("rows", String(IA_PAGE_ROWS));
    params.set("page", String(page));
    params.set("output", "json");
    const searchUrl = `https://archive.org/advancedsearch.php?${params}`;
    try {
        const res = await fetchWithTimeout(searchUrl);
        if (!res.ok) return [];
        const json = (await res.json()) as IaSearchResponse;
        return json.response?.docs || [];
    } catch {
        return [];
    }
}

// Download, validate, and keep one torrent. Returns true if it was added.
async function tryAddFromUrl(s: CorpusState, url: string, filename: string): Promise<boolean> {
    const dest = path.join(s.dir, filename);
    let buf: Buffer;
    try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return false;
        buf = Buffer.from(await res.arrayBuffer());
    } catch {
        return false;
    }

    let meta: TorrentMeta;
    try {
        meta = parseTorrentBuffer(buf);
    } catch {
        return false;
    }

    if (!hasUsableTracker(meta)) return false;
    const hash = meta.infoHash.toString("hex");
    if (s.seenHashes.has(hash)) return false;

    await writeFile(dest, buf);
    s.seenHashes.add(hash);
    s.count++;
    s.bytes += meta.totalLength;
    console.log(
        `[${s.count}/${s.targetCount}] +${(meta.totalLength / (1024 * 1024)).toFixed(0)}MB ` +
        `(${(s.bytes / GIB).toFixed(2)}GB) ${truncate(meta.name, 60)}`,
    );
    return true;
}

// We are tracker-only: a torrent is useful only if it lists at least one
// HTTP(S) or UDP tracker. wss-only / trackerless torrents are skipped.
function hasUsableTracker(meta: TorrentMeta): boolean {
    const urls = [meta.announce, ...meta.announceList.flat()].filter(Boolean) as string[];
    return urls.some((u) => /^(https?|udp):\/\//i.test(u));
}

async function fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { signal: controller.signal, redirect: "follow" });
    } finally {
        clearTimeout(timer);
    }
}

// Small seeded PRNG (mulberry32) so a given seed always yields the same set.
function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function range(from: number, to: number): number[] {
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
}

function sanitize(id: string): string {
    return id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
}

main().catch((e) => { console.error(e); process.exit(1); });
