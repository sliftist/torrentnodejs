// Global cap on simultaneous tracker operations (announce/connect/scrape) across
// every torrent. With thousands of torrents each announcing to several trackers,
// firing them all at once buries the single tunnel: most requests sit unanswered
// (and time out), so seeding torrents never complete an announce and look like
// they have no trackers. Funnelling announces through this gate keeps a bounded
// number in flight at a time, so each one actually gets a response.
export class AnnounceGate {
    private active = 0;
    private readonly waiters: (() => void)[] = [];

    constructor(private max: number) {}

    setMax(max: number): void {
        this.max = Math.max(1, max);
        // Opening up may let queued operations start.
        while (this.active < this.max && this.waiters.length) {
            const next = this.waiters.shift();
            if (next) next();
        }
    }

    async run<T>(fn: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await fn();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.max) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.waiters.push(() => { this.active++; resolve(); });
        });
    }

    private release(): void {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
}
