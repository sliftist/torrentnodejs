import { EventEmitter } from "events";
import { Transport } from "./transport";
import { AnnounceParams, TrackerAnnounceResult, PeerAddress, announceHttp } from "./trackerHttp";
import { announceUdp } from "./trackerUdp";

export interface TrackerPoolOptions {
    transport: Transport;
    trackers: string[][];           // tiered (BEP 12)
    params(): AnnounceParams;       // called freshly for each announce
    maxConsecutiveFailures?: number;
    minIntervalSec?: number;
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
            this.inflight.push(this.runLoop(url));
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

    private announceOnce(url: string, event?: "started" | "stopped" | "completed"): Promise<TrackerAnnounceResult> {
        const params = { ...this.opts.params(), event };
        if (url.startsWith("udp://")) return announceUdp(this.opts.transport, url, params);
        return announceHttp(this.opts.transport, url, params);
    }
}

function isSupported(url: string): boolean {
    return url.startsWith("udp://") || url.startsWith("http://") || url.startsWith("https://");
}
