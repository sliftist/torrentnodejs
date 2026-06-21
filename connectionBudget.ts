// Global cap on simultaneous peer connections across every torrent. Both
// outbound dials and accepted inbound peers acquire a slot; dropping a peer
// releases it. Per-torrent caps are enforced separately by each Torrent.
export class ConnectionBudget {
    private active = 0;

    constructor(private max: number) {}

    get count(): number { return this.active; }
    get hasRoom(): boolean { return this.active < this.max; }

    setMax(max: number): void { this.max = max; }

    // Returns true and reserves a slot if there's room, false otherwise.
    acquire(): boolean {
        if (this.active >= this.max) return false;
        this.active++;
        return true;
    }

    release(): void {
        if (this.active > 0) this.active--;
    }
}
