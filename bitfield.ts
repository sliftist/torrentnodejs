// MSB-first bitfield (BEP 3): bit at index i lives in
// `bytes[i >> 3]` at bit position `7 - (i & 7)`.

export class Bitfield {
    readonly bytes: Buffer;
    readonly length: number;

    constructor(length: number, bytes?: Buffer) {
        this.length = length;
        const expectedBytes = Math.ceil(length / 8);
        if (bytes) {
            if (bytes.length !== expectedBytes) {
                throw new Error(`Bitfield of length ${length} needs ${expectedBytes} bytes, got ${bytes.length}`);
            }
            this.bytes = Buffer.from(bytes);
        } else {
            this.bytes = Buffer.alloc(expectedBytes);
        }
    }

    get(i: number): boolean {
        if (i < 0 || i >= this.length) return false;
        return (this.bytes[i >>> 3] & (0x80 >>> (i & 7))) !== 0;
    }

    set(i: number): void {
        if (i < 0 || i >= this.length) throw new Error(`Index ${i} out of range [0, ${this.length})`);
        this.bytes[i >>> 3] |= 0x80 >>> (i & 7);
    }

    clear(i: number): void {
        if (i < 0 || i >= this.length) throw new Error(`Index ${i} out of range [0, ${this.length})`);
        this.bytes[i >>> 3] &= ~(0x80 >>> (i & 7)) & 0xff;
    }

    popcount(): number {
        let n = 0;
        for (const b of this.bytes) n += POPCOUNT[b];
        // Trim spurious bits past `length` (tail padding bits in the last byte).
        // We never set them, but if loaded from the wire they could be set.
        const tailBits = (8 - (this.length & 7)) & 7;
        if (tailBits > 0 && this.length > 0) {
            const lastIdx = this.bytes.length - 1;
            const mask = (0xff << tailBits) & 0xff;
            const tail = this.bytes[lastIdx] & ~mask & 0xff;
            n -= POPCOUNT[tail];
        }
        return n;
    }

    hasAll(): boolean {
        return this.popcount() === this.length;
    }

    hasNone(): boolean {
        for (const b of this.bytes) if (b !== 0) return false;
        return true;
    }

    *indices(): IterableIterator<number> {
        for (let i = 0; i < this.length; i++) if (this.get(i)) yield i;
    }
}

const POPCOUNT = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        let n = 0;
        for (let x = i; x; x &= x - 1) n++;
        t[i] = n;
    }
    return t;
})();
