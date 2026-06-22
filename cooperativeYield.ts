// Cooperative yielding to keep the UI responsive during long synchronous bursts.
//
// Lots of our startup/teardown work is microtask-bound: it churns through many
// torrents (constructing them, walking every piece, draining file stats, pushing
// TCP RSTs through the WireGuard transport) without ever awaiting real IO, so the
// event loop never reaches its timer/poll phases. Ink schedules its renders on a
// setTimeout throttle, so while such a burst runs the terminal simply freezes —
// no redraws, no input — for as long as the burst lasts (tens of seconds when a
// big library scans on startup).
//
// Call yieldIfBlocked() inside any such loop, awaiting it. It tracks when we last
// yielded and does nothing until we've been running synchronously past the
// threshold, so the common (small/fast) case pays nothing. When it does yield it
// waits a short real interval — not just setImmediate — so timer-scheduled work,
// the Ink render in particular, actually gets a slice before we resume.

const YIELD_AFTER_MS = 50;
const YIELD_PAUSE_MS = 10;

let lastYieldMs = Date.now();

export async function yieldIfBlocked(): Promise<void> {
    if (Date.now() - lastYieldMs < YIELD_AFTER_MS) return;
    await new Promise<void>((resolve) => setTimeout(resolve, YIELD_PAUSE_MS));
    lastYieldMs = Date.now();
}
