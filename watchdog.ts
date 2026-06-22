import { startMeasure, MeasureProfile, createMeasureProfile, addToMeasureProfile } from "./measure";

// Rolling window we report over. Counts/time are always "in the last 60s".
const WINDOW_MS = 60_000;
// How often we close the open measure profile and start a fresh one. This is the
// granularity of the rolling window (a trailing partial bucket is fine).
const FLUSH_MS = 2000;

export interface WatchdogLine {
    name: string;
    count: number;
    timeMs: number;
}

interface Bucket {
    endTime: number;
    profile: MeasureProfile;
}

interface WorkerSample {
    time: number;
    name: string;
    ms: number;
}

// Aggregates main-thread time captured by socket-function's measure shims, plus
// manually-reported worker-thread time, into a rolling 60s view of "what work is
// the process actually spending time on". Main-thread numbers come from
// @measureFnc-decorated methods (only recorded while a profile is open, which is
// why we always keep one open here). Worker time can't be captured by the shims
// because it runs in another thread, so callers report it via recordWorker.
class Watchdog {
    private buckets: Bucket[] = [];
    private current = startMeasure();
    private workerSamples: WorkerSample[] = [];
    private timer?: NodeJS.Timeout;

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.flush(), FLUSH_MS);
        this.timer.unref?.();
    }

    recordWorker(name: string, ms: number): void {
        this.workerSamples.push({ time: Date.now(), name, ms });
    }

    private flush(): void {
        const profile = this.current.finish();
        this.buckets.push({ endTime: Date.now(), profile });
        this.current = startMeasure();
        this.prune();
    }

    private prune(): void {
        const cutoff = Date.now() - WINDOW_MS;
        this.buckets = this.buckets.filter(b => b.endTime >= cutoff);
        this.workerSamples = this.workerSamples.filter(s => s.time >= cutoff);
    }

    mainLines(): WatchdogLine[] {
        this.prune();
        const agg = createMeasureProfile();
        for (const b of this.buckets) addToMeasureProfile(agg, b.profile);
        const lines: WatchdogLine[] = [];
        for (const name in agg.entries) {
            const e = agg.entries[name];
            lines.push({ name: friendlyName(name), count: e.ownTime.count, timeMs: e.ownTime.sum });
        }
        lines.sort((a, b) => b.timeMs - a.timeMs);
        return lines;
    }

    workerLines(): WatchdogLine[] {
        this.prune();
        const byName = new Map<string, WatchdogLine>();
        for (const s of this.workerSamples) {
            let line = byName.get(s.name);
            if (!line) {
                line = { name: s.name, count: 0, timeMs: 0 };
                byName.set(s.name, line);
            }
            line.count++;
            line.timeMs += s.ms;
        }
        const lines = [...byName.values()];
        lines.sort((a, b) => b.timeMs - a.timeMs);
        return lines;
    }
}

function friendlyName(name: string): string {
    return name.replace("(async)", "").replace("()", "").replaceAll("|", ".");
}

let shared: Watchdog | undefined;
export function sharedWatchdog(): Watchdog {
    if (!shared) {
        shared = new Watchdog();
        shared.start();
    }
    return shared;
}
