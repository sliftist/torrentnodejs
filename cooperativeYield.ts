// Cooperative yielding for synchronous send bursts.
//
// Tearing down many torrents at once pushes a long run of TCP RST packets
// through the WireGuard transport. Each send synchronously encrypts
// (ChaCha20-Poly1305, in JS) and hands the datagram to a native dgram send.
// Nothing on that path awaits real IO — the teardown is entirely
// microtask-bound — so the sends drain back-to-back without the event loop ever
// reaching its poll phase, starving terminal input and rendering. On Windows
// the native send is far slower, turning a sub-second Linux hiccup into
// multi-second freezes.
//
// Call yieldIfBlocked() inside such a loop. It only actually yields once we've
// been running synchronously past the threshold since the last yield, so the
// common (small) case pays nothing.

const YIELD_AFTER_MS = 50;

let lastYieldMs = Date.now();

export async function yieldIfBlocked(): Promise<void> {
    if (Date.now() - lastYieldMs < YIELD_AFTER_MS) return;
    // setImmediate fires after the poll phase, so pending socket reads and
    // terminal input/rendering get serviced before we resume.
    await new Promise<void>((resolve) => setImmediate(resolve));
    lastYieldMs = Date.now();
}
