import { EventEmitter } from "events";
import { Transport } from "./transport";
import { AnnounceParams, TrackerAnnounceResult, TrackerScrapeResult, PeerAddress, announceHttp, scrapeHttp } from "./trackerHttp";
import { announceUdp, scrapeUdp } from "./trackerUdp";

// Scrape carries no tracker-suggested interval, so we poll swarm stats on a
// fixed, gentle cadence.
const SCRAPE_INTERVAL_SEC = 120;

export interface TrackerPoolOptions {
    transport: Transport;
    trackers: string[][];           // tiered (BEP 12)
    params(): AnnounceParams;       // called freshly for each announce
    maxConsecutiveFailures?: number;
    minIntervalSec?: number;
    // When true, only scrape swarm stats — never announce, never surface peers.
    scrape?: boolean;
}

export interface TrackerStat {
    url: string;
    status: "pending" | "ok" | "error" | "unsupported";
    seeders?: number;
    leechers?: number;
    peers?: number;
    intervalSec?: number;
    lastAnnounceMs?: number;
    error?: string;
}

// Concurrently announces to every tracker we can handle (UDP + HTTP/HTTPS;
// wss/ws WebSocket trackers are silently skipped because we don't speak
// WebRTC). Emits 'peer' for every distinct peer address ever returned.
export class TrackerPool extends EventEmitter {
    private readonly seen = new Map<string, PeerAddress>();
    private readonly statsByUrl = new Map<string, TrackerStat>();
    private stopped = false;
    private inflight: Promise<void>[] = [];
    private readonly maxFails: number;
    private readonly minInterval: number;
    private readonly pendingSleeps = new Set<{ resolve: () => void; timer: NodeJS.Timeout }>();

    constructor(private readonly opts: TrackerPoolOptions) {
        super();
        this.maxFails = opts.maxConsecutiveFailures ?? 3;
        this.minInterval = opts.minIntervalSec ?? 60;
    }

    get peers(): PeerAddress[] {
        return [...this.seen.values()];
    }

    get trackerStats(): TrackerStat[] {
        return [...this.statsByUrl.values()];
    }

    start(): void {
        const flat = new Set<string>();
        for (const tier of this.opts.trackers) for (const t of tier) flat.add(t);
        for (const url of flat) {
            if (!isSupported(url)) {
                this.statsByUrl.set(url, { url, status: "unsupported" });
                continue;
            }
            this.statsByUrl.set(url, { url, status: "pending" });
            if (this.opts.scrape) this.inflight.push(this.scrapeLoop(url));
            else this.inflight.push(this.runLoop(url));
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const s of this.pendingSleeps) {
            clearTimeout(s.timer);
            s.resolve();
        }
        this.pendingSleeps.clear();
        await Promise.allSettled(this.inflight);
    }

    private interruptibleSleep(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            if (this.stopped) { resolve(); return; }
            const entry = { resolve, timer: setTimeout(() => { this.pendingSleeps.delete(entry); resolve(); }, ms) };
            entry.timer.unref?.();
            this.pendingSleeps.add(entry);
        });
    }

    private async runLoop(url: string): Promise<void> {
        let event: "started" | undefined = "started";
        let consecutiveFailures = 0;
        while (!this.stopped) {
            try {
                const result = await this.announceOnce(url, event);
                event = undefined;
                consecutiveFailures = 0;
                this.statsByUrl.set(url, {
                    url,
                    status: "ok",
                    seeders: result.seeders,
                    leechers: result.leechers,
                    peers: result.peers.length,
                    intervalSec: result.interval,
                    lastAnnounceMs: Date.now(),
                });
                this.emit("announce", { url, ...result });
                for (const p of result.peers) {
                    const key = `${p.ip}:${p.port}`;
                    if (!this.seen.has(key)) {
                        this.seen.set(key, p);
                        this.emit("peer", p);
                    }
                }
                const sleepSec = Math.max(this.minInterval, result.minInterval || result.interval);
                await this.interruptibleSleep(sleepSec * 1000);
            } catch (e) {
                consecutiveFailures++;
                this.statsByUrl.set(url, {
                    url,
                    status: "error",
                    error: (e as Error).message,
                    lastAnnounceMs: Date.now(),
                });
                this.emit("tracker-error", { url, error: e });
                if (consecutiveFailures >= this.maxFails) return;
                await this.interruptibleSleep(30_000);
            }
        }
    }

    private async scrapeLoop(url: string): Promise<void> {
        let consecutiveFailures = 0;
        while (!this.stopped) {
            try {
                const result = await this.scrapeOnce(url);
                consecutiveFailures = 0;
                this.statsByUrl.set(url, {
                    url,
                    status: "ok",
                    seeders: result.seeders,
                    leechers: result.leechers,
                    peers: result.seeders + result.leechers,
                    lastAnnounceMs: Date.now(),
                });
                this.emit("scrape", { url, ...result });
                await this.interruptibleSleep(Math.max(this.minInterval, SCRAPE_INTERVAL_SEC) * 1000);
            } catch (e) {
                consecutiveFailures++;
                this.statsByUrl.set(url, {
                    url,
                    status: "error",
                    error: (e as Error).message,
                    lastAnnounceMs: Date.now(),
                });
                this.emit("tracker-error", { url, error: e });
                if (consecutiveFailures >= this.maxFails) return;
                await this.interruptibleSleep(30_000);
            }
        }
    }

    private scrapeOnce(url: string): Promise<TrackerScrapeResult> {
        const infoHash = this.opts.params().infoHash;
        if (url.startsWith("udp://")) return scrapeUdp(this.opts.transport, url, infoHash);
        return scrapeHttp(this.opts.transport, url, infoHash);
    }

    private announceOnce(url: string, event?: "started" | "stopped" | "completed"): Promise<TrackerAnnounceResult> {
        const params = { ...this.opts.params(), event };
        if (url.startsWith("udp://")) return announceUdp(this.opts.transport, url, params);
        return announceHttp(this.opts.transport, url, params);
    }
}

function isSupported(url: string): boolean {
    return url.startsWith("udp://") || url.startsWith("http://") || url.startsWith("https://");
}
