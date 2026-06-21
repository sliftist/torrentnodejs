// Cumulative outbound-dial counters, shared across every torrent so the totals
// survive torrents being torn down and recreated (e.g. on a mode change). A
// "dial" is an outbound peer connection attempt; "failures" are the dials that
// never reached a working peer — refused, timed out, or a bad handshake.
export class DialStats {
    private attemptsField = 0;
    private failuresField = 0;

    attempt(): void { this.attemptsField++; }
    fail(): void { this.failuresField++; }

    get attempts(): number { return this.attemptsField; }
    get failures(): number { return this.failuresField; }
}
