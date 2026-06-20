import assert from "assert";
import { decode, encode, decodeTorrent, BencodeDict } from "../bencode";

export async function runBencodeTests() {
    // Spec vectors
    assert.strictEqual(decode(Buffer.from("i42e")), 42);
    assert.strictEqual(decode(Buffer.from("i-7e")), -7);
    assert.strictEqual(decode(Buffer.from("i0e")), 0);
    assert.strictEqual((decode(Buffer.from("3:foo")) as Buffer).toString(), "foo");
    assert.deepStrictEqual(decode(Buffer.from("le")), []);
    assert.deepStrictEqual(decode(Buffer.from("li1ei2ei3ee")), [1, 2, 3]);

    const dict = decode(Buffer.from("d3:bari2e3:fooi1ee")) as BencodeDict;
    assert.strictEqual(dict["bar"], 2);
    assert.strictEqual(dict["foo"], 1);

    // Encoder sorts keys
    const enc = encode({ foo: 1, bar: 2 });
    assert.strictEqual(enc.toString(), "d3:bari2e3:fooi1ee");

    // Binary safety: bytes that aren't valid UTF-8 round-trip via Buffer
    const binary = Buffer.from([0x00, 0xff, 0xc3, 0x28, 0xfe]);
    const roundtripped = decode(encode(binary)) as Buffer;
    assert.deepStrictEqual(roundtripped, binary);

    // Nested
    const complex = { a: [1, Buffer.from("xy"), { z: Buffer.from("w") }], b: 9 };
    assert.deepStrictEqual(decode(encode(complex)), complex);

    // Trailing bytes → throw
    assert.throws(() => decode(Buffer.from("i1ei2e")));

    // decodeTorrent: info slice bounds
    const t = encode({
        announce: Buffer.from("http://t/"),
        info: { length: 7, name: Buffer.from("x"), "piece length": 16384, pieces: Buffer.alloc(20) },
    });
    const r = decodeTorrent(t);
    const sliced = t.subarray(r.infoStart, r.infoEnd);
    // The slice should round-trip to the same dict
    const reparsed = decode(sliced) as BencodeDict;
    assert.strictEqual(reparsed["length"], 7);
    assert.strictEqual((reparsed["name"] as Buffer).toString(), "x");

    console.log("Bencode tests passed.");
}
