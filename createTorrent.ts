import crypto from "crypto";
import { readFile } from "fs/promises";
import { BencodeDict, BencodeValue, encode } from "./bencode";
import { TorrentMeta, parseTorrentBuffer } from "./torrentFile";

export interface CreateTorrentOptions {
    name: string;
    pieceLength?: number;            // default 256 KiB
    announce?: string;
    announceList?: string[][];
    createdBy?: string;
    creationDate?: number;
    comment?: string;
    isPrivate?: boolean;
}

const DEFAULT_PIECE_LENGTH = 256 * 1024;

export async function createTorrentFromFile(
    filePath: string,
    options: CreateTorrentOptions,
): Promise<{ buffer: Buffer; meta: TorrentMeta }> {
    const data = await readFile(filePath);
    return createTorrentFromData(data, options);
}

export function createTorrentFromData(
    data: Buffer,
    options: CreateTorrentOptions,
): { buffer: Buffer; meta: TorrentMeta } {
    const pieceLength = options.pieceLength || DEFAULT_PIECE_LENGTH;
    if (pieceLength < 16 * 1024 || (pieceLength & (pieceLength - 1)) !== 0) {
        throw new Error(`pieceLength must be a power-of-two >= 16 KiB, was ${pieceLength}`);
    }
    const numPieces = Math.max(1, Math.ceil(data.length / pieceLength));
    const pieces = Buffer.alloc(numPieces * 20);
    for (let i = 0; i < numPieces; i++) {
        const slice = data.subarray(i * pieceLength, Math.min(data.length, (i + 1) * pieceLength));
        crypto.createHash("sha1").update(slice).digest().copy(pieces, i * 20);
    }

    const info: BencodeDict = {
        name: Buffer.from(options.name, "utf8"),
        "piece length": pieceLength,
        pieces,
        length: data.length,
    };
    if (options.isPrivate) info["private"] = 1;

    const torrent: BencodeDict = { info: info as unknown as BencodeValue };
    if (options.announce) torrent["announce"] = Buffer.from(options.announce, "utf8");
    if (options.announceList) {
        torrent["announce-list"] = options.announceList.map((tier) =>
            tier.map((t) => Buffer.from(t, "utf8")),
        );
    }
    if (options.createdBy) torrent["created by"] = Buffer.from(options.createdBy, "utf8");
    if (options.creationDate) torrent["creation date"] = options.creationDate;
    if (options.comment) torrent["comment"] = Buffer.from(options.comment, "utf8");

    const buffer = encode(torrent);
    const meta = parseTorrentBuffer(buffer);
    return { buffer, meta };
}

export function magnetUri(meta: TorrentMeta): string {
    const parts = [
        `xt=urn:btih:${meta.infoHash.toString("hex")}`,
        `dn=${encodeURIComponent(meta.name)}`,
    ];
    for (const tier of meta.announceList) {
        for (const t of tier) parts.push(`tr=${encodeURIComponent(t)}`);
    }
    return "magnet:?" + parts.join("&");
}
