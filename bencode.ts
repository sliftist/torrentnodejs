// Bencode (BEP 3). Strings are kept as Buffers so binary fields like
// `info.pieces` round-trip without UTF-8 corruption. Dict keys are exposed as
// JS strings (UTF-8 decoded) because that's what every real torrent uses.

export type BencodeValue = number | Buffer | BencodeValue[] | BencodeDict;
export interface BencodeDict { [key: string]: BencodeValue }

const D = 0x64; // 'd'
const L = 0x6c; // 'l'
const I = 0x69; // 'i'
const E = 0x65; // 'e'
const COLON = 0x3a;

export function decode(input: Buffer): BencodeValue {
    const step = decodeFrom(input, 0);
    if (step.end !== input.length) {
        throw new Error(`Trailing bytes after bencode value at offset ${step.end} of ${input.length}`);
    }
    return step.value;
}

export function encode(value: BencodeValue): Buffer {
    const parts: Buffer[] = [];
    encodeTo(value, parts);
    return Buffer.concat(parts);
}

// Decode a top-level dict and also return the byte range of the "info" entry
// so callers can SHA-1 the source bytes (info_hash must be over the EXACT
// bytes from the source, not a re-encode, since key order isn't always
// canonical in the wild).
export interface TorrentDecodeResult {
    value: BencodeDict;
    infoStart: number;
    infoEnd: number;
}

export function decodeTorrent(input: Buffer): TorrentDecodeResult {
    if (input[0] !== D) throw new Error(`Torrent file must start with 'd', was 0x${input[0]?.toString(16)}`);
    let pos = 1;
    const dict: BencodeDict = {};
    let infoStart = -1;
    let infoEnd = -1;
    while (input[pos] !== E) {
        if (pos >= input.length) throw new Error("Unterminated top-level dict");
        const keyStep = decodeByteString(input, pos);
        const key = (keyStep.value as Buffer).toString("utf8");
        pos = keyStep.end;
        const valStart = pos;
        const valStep = decodeFrom(input, pos);
        if (key === "info") {
            infoStart = valStart;
            infoEnd = valStep.end;
        }
        dict[key] = valStep.value;
        pos = valStep.end;
    }
    if (infoStart < 0) throw new Error(`Torrent file missing "info" dict`);
    return { value: dict, infoStart, infoEnd };
}

interface DecodeStep { value: BencodeValue; end: number }

function decodeFrom(input: Buffer, offset: number): DecodeStep {
    const c = input[offset];
    if (c === I) return decodeInt(input, offset);
    if (c === L) return decodeList(input, offset);
    if (c === D) return decodeDict(input, offset);
    if (c >= 0x30 && c <= 0x39) return decodeByteString(input, offset);
    throw new Error(`Unexpected bencode byte 0x${c?.toString(16)} at offset ${offset}`);
}

function decodeInt(input: Buffer, offset: number): DecodeStep {
    const end = input.indexOf(E, offset + 1);
    if (end < 0) throw new Error(`Unterminated integer at offset ${offset}`);
    const numStr = input.subarray(offset + 1, end).toString("ascii");
    if (!/^-?\d+$/.test(numStr)) throw new Error(`Invalid integer "${numStr}" at offset ${offset}`);
    const value = parseInt(numStr, 10);
    if (!Number.isSafeInteger(value)) {
        throw new Error(`Integer "${numStr}" exceeds JS safe integer range at offset ${offset}`);
    }
    return { value, end: end + 1 };
}

function decodeByteString(input: Buffer, offset: number): DecodeStep {
    const colon = input.indexOf(COLON, offset);
    if (colon < 0) throw new Error(`Unterminated byte string length at offset ${offset}`);
    const lenStr = input.subarray(offset, colon).toString("ascii");
    if (!/^\d+$/.test(lenStr)) throw new Error(`Invalid byte string length "${lenStr}" at offset ${offset}`);
    const len = parseInt(lenStr, 10);
    const start = colon + 1;
    const end = start + len;
    if (end > input.length) throw new Error(`Byte string of length ${len} exceeds input at offset ${offset}`);
    return { value: Buffer.from(input.subarray(start, end)), end };
}

function decodeList(input: Buffer, offset: number): DecodeStep {
    let pos = offset + 1;
    const items: BencodeValue[] = [];
    while (input[pos] !== E) {
        if (pos >= input.length) throw new Error(`Unterminated list at offset ${offset}`);
        const step = decodeFrom(input, pos);
        items.push(step.value);
        pos = step.end;
    }
    return { value: items, end: pos + 1 };
}

function decodeDict(input: Buffer, offset: number): DecodeStep {
    let pos = offset + 1;
    const dict: BencodeDict = {};
    while (input[pos] !== E) {
        if (pos >= input.length) throw new Error(`Unterminated dict at offset ${offset}`);
        const keyStep = decodeByteString(input, pos);
        const key = (keyStep.value as Buffer).toString("utf8");
        pos = keyStep.end;
        const valStep = decodeFrom(input, pos);
        dict[key] = valStep.value;
        pos = valStep.end;
    }
    return { value: dict, end: pos + 1 };
}

function encodeTo(value: BencodeValue, out: Buffer[]): void {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error(`Cannot encode non-integer ${value}`);
        out.push(Buffer.from(`i${value}e`, "ascii"));
        return;
    }
    if (Buffer.isBuffer(value)) {
        out.push(Buffer.from(`${value.length}:`, "ascii"));
        out.push(value);
        return;
    }
    if (Array.isArray(value)) {
        out.push(Buffer.from("l", "ascii"));
        for (const item of value) encodeTo(item, out);
        out.push(Buffer.from("e", "ascii"));
        return;
    }
    if (typeof value === "object" && value) {
        out.push(Buffer.from("d", "ascii"));
        // Bencode dicts must be sorted by key (BEP 3).
        const keys = Object.keys(value).sort();
        for (const key of keys) {
            const keyBuf = Buffer.from(key, "utf8");
            out.push(Buffer.from(`${keyBuf.length}:`, "ascii"));
            out.push(keyBuf);
            encodeTo(value[key], out);
        }
        out.push(Buffer.from("e", "ascii"));
        return;
    }
    throw new Error(`Cannot encode value of type ${typeof value}`);
}
