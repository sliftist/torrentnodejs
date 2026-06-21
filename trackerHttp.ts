import { Transport } from "./transport";
import { decode, BencodeDict, BencodeValue } from "./bencode";

export interface PeerAddress {
    ip: string;
    port: number;
}

export interface AnnounceParams {
    infoHash: Buffer;
    peerId: Buffer;
    port: number;
    uploaded: number;
    downloaded: number;
    left: number;
    event?: "started" | "stopped" | "completed";
    numWant?: number;
}

export interface TrackerAnnounceResult {
    interval: number;        // seconds — recommended re-announce interval
    minInterval?: number;
    peers: PeerAddress[];
    seeders?: number;
    leechers?: number;
}

export interface TrackerScrapeResult {
    seeders: number;         // "complete"
    completed: number;       // "downloaded" (lifetime completed downloads)
    leechers: number;        // "incomplete"
}

export async function announceHttp(transport: Transport, trackerUrl: string, params: AnnounceParams): Promise<TrackerAnnounceResult> {
    const qs = [
        `info_hash=${urlEncodeBytes(params.infoHash)}`,
        `peer_id=${urlEncodeBytes(params.peerId)}`,
        `port=${params.port}`,
        `uploaded=${params.uploaded}`,
        `downloaded=${params.downloaded}`,
        `left=${params.left}`,
        "compact=1",
        `numwant=${params.numWant || 50}`,
    ];
    if (params.event) qs.push(`event=${params.event}`);
    const sep = trackerUrl.includes("?") ? "&" : "?";
    const url = `${trackerUrl}${sep}${qs.join("&")}`;

    const res = await transport.fetch(url, { timeoutMs: 10_000 });
    if (res.status !== 200) {
        throw new Error(`Tracker ${trackerUrl} returned HTTP ${res.status}`);
    }
    const dict = decode(res.body) as BencodeDict;
    const failure = dict["failure reason"];
    if (Buffer.isBuffer(failure)) {
        throw new Error(`Tracker ${trackerUrl} failure: ${failure.toString("utf8")}`);
    }
    const interval = expectNumber(dict["interval"], "interval");
    const minInterval = typeof dict["min interval"] === "number" ? dict["min interval"] : undefined;
    const peers = parseCompactPeers(dict["peers"]);
    const seeders = typeof dict["complete"] === "number" ? dict["complete"] : undefined;
    const leechers = typeof dict["incomplete"] === "number" ? dict["incomplete"] : undefined;
    return { interval, minInterval, peers, seeders, leechers };
}

export async function scrapeHttp(transport: Transport, trackerUrl: string, infoHash: Buffer): Promise<TrackerScrapeResult> {
    const scrapeUrl = deriveScrapeUrl(trackerUrl);
    const sep = scrapeUrl.includes("?") && "&" || "?";
    const url = `${scrapeUrl}${sep}info_hash=${urlEncodeBytes(infoHash)}`;
    const res = await transport.fetch(url, { timeoutMs: 10_000 });
    if (res.status !== 200) {
        throw new Error(`Tracker scrape ${scrapeUrl} returned HTTP ${res.status}`);
    }
    const dict = decode(res.body) as BencodeDict;
    const failure = dict["failure reason"];
    if (Buffer.isBuffer(failure)) {
        throw new Error(`Tracker scrape ${scrapeUrl} failure: ${failure.toString("utf8")}`);
    }
    const files = dict["files"];
    if (!files || typeof files !== "object" || Buffer.isBuffer(files) || Array.isArray(files)) {
        throw new Error(`Scrape response from ${scrapeUrl} missing "files" dict`);
    }
    // We scrape a single info_hash, so the files dict has one entry. Read it by
    // value: its key is the raw 20-byte hash, which utf8 dict keys can't carry.
    const entry = Object.values(files as BencodeDict)[0];
    if (!entry || typeof entry !== "object" || Buffer.isBuffer(entry) || Array.isArray(entry)) {
        throw new Error(`Scrape response from ${scrapeUrl} has no file entry`);
    }
    const e = entry as BencodeDict;
    return {
        seeders: typeof e["complete"] === "number" && e["complete"] || 0,
        completed: typeof e["downloaded"] === "number" && e["downloaded"] || 0,
        leechers: typeof e["incomplete"] === "number" && e["incomplete"] || 0,
    };
}

// BEP 48: the scrape URL is the announce URL with the final path segment's
// leading "announce" replaced by "scrape". A tracker whose path doesn't end in
// "announce..." doesn't advertise scrape support.
export function deriveScrapeUrl(announceUrl: string): string {
    const u = new URL(announceUrl);
    const slash = u.pathname.lastIndexOf("/");
    const last = u.pathname.slice(slash + 1);
    if (!last.startsWith("announce")) {
        throw new Error(`Tracker ${announceUrl} does not support scrape (path "${u.pathname}")`);
    }
    u.pathname = u.pathname.slice(0, slash + 1) + "scrape" + last.slice("announce".length);
    return u.toString();
}

export function parseCompactPeers(raw: BencodeValue | undefined): PeerAddress[] {
    if (raw === undefined) return [];
    if (Buffer.isBuffer(raw)) {
        if (raw.length % 6 !== 0) {
            throw new Error(`Compact peers length ${raw.length} not divisible by 6`);
        }
        const out: PeerAddress[] = [];
        for (let i = 0; i < raw.length; i += 6) {
            const ip = `${raw[i]}.${raw[i + 1]}.${raw[i + 2]}.${raw[i + 3]}`;
            const port = raw.readUInt16BE(i + 4);
            if (port === 0) continue;
            out.push({ ip, port });
        }
        return out;
    }
    if (Array.isArray(raw)) {
        return raw.map((p, i) => {
            if (!p || Buffer.isBuffer(p) || typeof p !== "object" || Array.isArray(p)) {
                throw new Error(`peers[${i}] is not a dict`);
            }
            const pd = p as BencodeDict;
            const ipRaw = pd["ip"];
            const portRaw = pd["port"];
            if (!Buffer.isBuffer(ipRaw)) throw new Error(`peers[${i}].ip not a string`);
            if (typeof portRaw !== "number") throw new Error(`peers[${i}].port not a number`);
            return { ip: ipRaw.toString("utf8"), port: portRaw };
        });
    }
    throw new Error(`Unrecognized peers field type`);
}

function expectNumber(v: BencodeValue | undefined, label: string): number {
    if (typeof v !== "number") throw new Error(`Expected ${label} to be a number`);
    return v;
}

// URL-encode raw bytes per BEP 3 (only ASCII alphanumerics + "-._~" stay literal).
function urlEncodeBytes(buf: Buffer): string {
    let out = "";
    for (const b of buf) {
        const isUnreserved = (b >= 0x30 && b <= 0x39)
            || (b >= 0x41 && b <= 0x5a)
            || (b >= 0x61 && b <= 0x7a)
            || b === 0x2d || b === 0x2e || b === 0x5f || b === 0x7e;
        if (isUnreserved) out += String.fromCharCode(b);
        else out += "%" + b.toString(16).padStart(2, "0").toUpperCase();
    }
    return out;
}
