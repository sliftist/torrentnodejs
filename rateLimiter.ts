// Global token-bucket rate limiter shared across every peer connection.
//
// Callers `await take(n)` before sending/accepting `n` bytes; the promise
// resolves once enough tokens have accrued. The bucket refills continuously at
// `bytesPerSec` and bursts up to one second's worth. A rate of <= 0 means
// unlimited — `take` returns immediately.
//
// We apply this to OUTBOUND request pacing (download) and OUTBOUND piece sends
// (upload). Pacing requests throttles the inbound rate to roughly the limit
// without needing to buffer or drop already-arrived bytes.
export class RateLimiter {
    private bytesPerSec: number;
    private tokens: number;
    private lastRefillMs = Date.now();

    constructor(bytesPerSec: number) {
        this.bytesPerSec = bytesPerSec;
        this.tokens = bytesPerSec;
    }

    setRate(bytesPerSec: number): void {
        this.bytesPerSec = bytesPerSec;
        if (this.tokens > bytesPerSec) this.tokens = bytesPerSec;
    }

    async take(n: number): Promise<void> {
        if (this.bytesPerSec <= 0) return;
        this.refill();
        this.tokens -= n;
        while (this.tokens < 0) {
            const waitMs = Math.max(5, (-this.tokens / this.bytesPerSec) * 1000);
            await new Promise<void>((r) => setTimeout(r, waitMs));
            this.refill();
        }
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = (now - this.lastRefillMs) / 1000;
        if (elapsed <= 0) return;
        this.lastRefillMs = now;
        const cap = this.bytesPerSec;
        this.tokens = Math.min(cap, this.tokens + elapsed * this.bytesPerSec);
    }
}
