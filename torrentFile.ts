import crypto from "crypto";
import { readFile } from "fs/promises";
import { decodeTorrent, BencodeDict, BencodeValue } from "./bencode";

export interface TorrentFile {
    path: string[];
    length: number;
    // Byte offset where this file starts in the concatenated piece stream.
    offsetInTorrent: number;
}

export interface TorrentMeta {
    infoHash: Buffer;                 // 20 bytes (v1 SHA-1)
    name: string;
    pieceLength: number;
    pieceHashes: Buffer[];            // each 20 bytes
    files: TorrentFile[];             // single-file → 1 entry
    totalLength: number;
    isPrivate: boolean;
    announce?: string;
    announceList: string[][];         // tiered (BEP 12)
    createdBy?: string;
    creationDate?: number;            // unix seconds
    comment?: string;
    urlList?: string[];               // webseeds (BEP 19)
}

export async function parseTorrentFile(path: string): Promise<TorrentMeta> {
    return parseTorrentBuffer(await readFile(path));
}

export function parseTorrentBuffer(buf: Buffer): TorrentMeta {
    const { value, infoStart, infoEnd } = decodeTorrent(buf);
    const infoHash = crypto.createHash("sha1").update(buf.subarray(infoStart, infoEnd)).digest();

    const info = expectDict(value, "info");
    const name = expectBuffer(info, "name").toString("utf8");
    const pieceLength = expectInt(info, "piece length");
    const piecesBuf = expectBuffer(info, "pieces");
    if (piecesBuf.length % 20 !== 0) {
        throw new Error(`info.pieces length ${piecesBuf.length} is not a multiple of 20`);
    }
    const pieceHashes: Buffer[] = [];
    for (let i = 0; i < piecesBuf.length; i += 20) {
        pieceHashes.push(Buffer.from(piecesBuf.subarray(i, i + 20)));
    }

    const files: TorrentFile[] = [];
    let totalLength = 0;
    if (info["files"] !== undefined) {
        const arr = expectList(info, "files");
        for (const f of arr) {
            const fd = asDict(f, "files entry");
            const length = expectInt(fd, "length");
            const pathParts = expectList(fd, "path").map((p, i) => {
                if (!Buffer.isBuffer(p)) throw new Error(`Expected string at path[${i}], was ${typeName(p)}`);
                return p.toString("utf8");
            });
            files.push({ path: [name, ...pathParts], length, offsetInTorrent: totalLength });
            totalLength += length;
        }
    } else if (info["length"] !== undefined) {
        const length = expectInt(info, "length");
        files.push({ path: [name], length, offsetInTorrent: 0 });
        totalLength = length;
    } else {
        throw new Error(`Torrent "info" has neither "files" nor "length"`);
    }

    const expectedPieces = Math.ceil(totalLength / pieceLength);
    if (pieceHashes.length !== expectedPieces) {
        throw new Error(`Expected ${expectedPieces} piece hashes (totalLength ${totalLength} / pieceLength ${pieceLength}), got ${pieceHashes.length}`);
    }

    const isPrivate = info["private"] !== undefined && expectInt(info, "private") === 1;

    const announce = value["announce"] !== undefined
        ? expectBuffer(value, "announce").toString("utf8")
        : undefined;
    const announceList: string[][] = [];
    if (value["announce-list"] !== undefined) {
        for (const tier of expectList(value, "announce-list")) {
            if (!Array.isArray(tier)) throw new Error(`announce-list tier is not a list`);
            announceList.push(tier.map((t) => {
                if (!Buffer.isBuffer(t)) throw new Error(`announce-list tracker is not a string`);
                return t.toString("utf8");
            }));
        }
    } else if (announce) {
        announceList.push([announce]);
    }

    const createdBy = value["created by"] !== undefined ? expectBuffer(value, "created by").toString("utf8") : undefined;
    const creationDate = value["creation date"] !== undefined ? expectInt(value, "creation date") : undefined;
    const comment = value["comment"] !== undefined ? expectBuffer(value, "comment").toString("utf8") : undefined;

    let urlList: string[] | undefined;
    const rawUrlList = value["url-list"];
    if (Buffer.isBuffer(rawUrlList)) urlList = [rawUrlList.toString("utf8")];
    else if (Array.isArray(rawUrlList)) {
        urlList = rawUrlList.map((u, i) => {
            if (!Buffer.isBuffer(u)) throw new Error(`url-list[${i}] is not a string`);
            return u.toString("utf8");
        });
    }

    return {
        infoHash, name, pieceLength, pieceHashes, files, totalLength, isPrivate,
        announce, announceList, createdBy, creationDate, comment, urlList,
    };
}

// Length of piece `index`. Most pieces are pieceLength bytes; the last may be short.
export function pieceLengthAt(meta: TorrentMeta, index: number): number {
    if (index < 0 || index >= meta.pieceHashes.length) {
        throw new Error(`Piece index ${index} out of range [0, ${meta.pieceHashes.length})`);
    }
    if (index < meta.pieceHashes.length - 1) return meta.pieceLength;
    const remainder = meta.totalLength - meta.pieceLength * (meta.pieceHashes.length - 1);
    return remainder;
}

function asDict(v: BencodeValue, label: string): BencodeDict {
    if (!v || Buffer.isBuffer(v) || typeof v !== "object" || Array.isArray(v)) {
        throw new Error(`Expected dict for ${label}, was ${typeName(v)}`);
    }
    return v;
}
function expectDict(d: BencodeDict, key: string): BencodeDict {
    return asDict(d[key], key);
}
function expectBuffer(d: BencodeDict, key: string): Buffer {
    const v = d[key];
    if (!Buffer.isBuffer(v)) throw new Error(`Expected byte string at "${key}", was ${typeName(v)}`);
    return v;
}
function expectInt(d: BencodeDict, key: string): number {
    const v = d[key];
    if (typeof v !== "number") throw new Error(`Expected integer at "${key}", was ${typeName(v)}`);
    return v;
}
function expectList(d: BencodeDict, key: string): BencodeValue[] {
    const v = d[key];
    if (!Array.isArray(v)) throw new Error(`Expected list at "${key}", was ${typeName(v)}`);
    return v;
}
function typeName(v: BencodeValue | undefined): string {
    if (v === undefined) return "undefined";
    if (typeof v === "number") return "integer";
    if (Buffer.isBuffer(v)) return "byte string";
    if (Array.isArray(v)) return "list";
    return "dict";
}
