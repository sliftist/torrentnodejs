import { PeerConnection } from "./peerConnection";

interface Sample {
    lastDown: number;
    lastUp: number;
    score: number;
}

// Global tit-for-tat unchoke manager. Per the spec there are a fixed number of
// upload slots ("upload limit before choking") shared across ALL torrents, not
// per torrent. Every interval we rank interested peers by the rate at which
// they've been feeding us (download speed), unchoke the fastest few, and keep a
// couple of slots rotating randomly (optimistic unchoke) so new/unknown peers
// get a chance and we can discover faster ones.
//
// For peers we're purely seeding to (no download from them), the score falls
// back to how fast they take data from us, so active downloaders win the slots.
export class ChokeManager {
    private readonly peers = new Set<PeerConnection>();
    private readonly samples = new Map<PeerConnection, Sample>();
    private uploadSlots: number;
    private optimisticSlots: number;
    private readonly intervalMs: number;
    private timer?: NodeJS.Timeout;
    private lastRunMs = Date.now();

    constructor(config: { uploadSlots: number; optimisticSlots: number; intervalMs: number }) {
        this.uploadSlots = config.uploadSlots;
        this.optimisticSlots = config.optimisticSlots;
        this.intervalMs = config.intervalMs;
    }

    setSlots(config: { uploadSlots: number; optimisticSlots: number }): void {
        this.uploadSlots = config.uploadSlots;
        this.optimisticSlots = config.optimisticSlots;
    }

    add(conn: PeerConnection): void {
        this.peers.add(conn);
        this.samples.set(conn, { lastDown: conn.bytesDownloaded, lastUp: conn.bytesUploaded, score: 0 });
    }

    remove(conn: PeerConnection): void {
        this.peers.delete(conn);
        this.samples.delete(conn);
    }

    start(): void {
        if (this.timer) return;
        this.lastRunMs = Date.now();
        this.timer = setInterval(() => this.run(), this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private run(): void {
        const now = Date.now();
        const dt = Math.max(0.001, (now - this.lastRunMs) / 1000);
        this.lastRunMs = now;

        for (const conn of this.peers) {
            let sample = this.samples.get(conn);
            if (!sample) {
                sample = { lastDown: conn.bytesDownloaded, lastUp: conn.bytesUploaded, score: 0 };
                this.samples.set(conn, sample);
            }
            const downRate = Math.max(0, conn.bytesDownloaded - sample.lastDown) / dt;
            const upRate = Math.max(0, conn.bytesUploaded - sample.lastUp) / dt;
            sample.lastDown = conn.bytesDownloaded;
            sample.lastUp = conn.bytesUploaded;
            let score = downRate;
            if (score <= 0) score = upRate;
            sample.score = score;
        }

        const interested = [...this.peers].filter((c) => c.peerInterested);
        interested.sort((a, b) => (this.samples.get(b)?.score || 0) - (this.samples.get(a)?.score || 0));

        const regular = Math.max(0, this.uploadSlots - this.optimisticSlots);
        const toUnchoke = new Set<PeerConnection>(interested.slice(0, regular));

        // Optimistic slots: random picks from the interested peers that didn't
        // make the speed cut, so we keep probing for faster connections.
        const rest = interested.slice(regular);
        for (let i = 0; i < this.optimisticSlots && rest.length > 0; i++) {
            const idx = Math.floor(Math.random() * rest.length);
            toUnchoke.add(rest[idx]);
            rest.splice(idx, 1);
        }

        for (const conn of this.peers) {
            const want = toUnchoke.has(conn);
            if (want && conn.amChoking) conn.sendUnchoke();
            else if (!want && !conn.amChoking) conn.sendChoke();
        }
    }
}
