import assert from "assert";
import { Bitfield } from "../bitfield";

export async function runBitfieldTests() {
    // MSB-first: bit 0 is high bit of byte 0
    const a = new Bitfield(16);
    a.set(0);
    assert.strictEqual(a.bytes[0], 0x80);
    a.set(7);
    assert.strictEqual(a.bytes[0], 0x81);
    a.set(8);
    assert.strictEqual(a.bytes[1], 0x80);
    assert.strictEqual(a.popcount(), 3);
    assert.ok(a.get(0) && a.get(7) && a.get(8) && !a.get(1));

    // Tail bits beyond length are not counted, even if set in source
    const trailing = new Bitfield(5, Buffer.from([0xff]));
    assert.strictEqual(trailing.popcount(), 5);

    // hasAll
    const full = new Bitfield(8, Buffer.from([0xff]));
    assert.ok(full.hasAll());
    const partial = new Bitfield(8, Buffer.from([0xfe]));
    assert.ok(!partial.hasAll());

    // hasNone
    assert.ok(new Bitfield(16).hasNone());

    // clear
    const c = new Bitfield(16);
    c.set(3);
    c.set(10);
    c.clear(3);
    assert.ok(!c.get(3));
    assert.ok(c.get(10));

    // indices iterator
    const it = new Bitfield(20);
    for (const i of [0, 5, 12, 19]) it.set(i);
    assert.deepStrictEqual([...it.indices()], [0, 5, 12, 19]);

    console.log("Bitfield tests passed.");
}
