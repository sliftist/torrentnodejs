import crypto from "crypto";
import { readFile } from "fs/promises";
import { NodeTransport, Transport } from "./transport";
import { parseTorrentBuffer, TorrentMeta } from "./torrentFile";
import { Torrent, TorrentOptions } from "./torrent";

export interface BitTorrentClientOptions {
    transport?: Transport;
    peerId?: Buffer;
}

export class BitTorrentClient {
    readonly transport: Transport;
    readonly peerId: Buffer;
    private readonly torrents = new Set<Torrent>();

    constructor(opts: BitTorrentClientOptions = {}) {
        this.transport = opts.transport || new NodeTransport();
        this.peerId = opts.peerId || makePeerId();
    }

    async addTorrentFile(path: string, options: TorrentOptions): Promise<Torrent> {
        return this.addTorrentBuffer(await readFile(path), options);
    }

    async addTorrentBuffer(buf: Buffer, options: TorrentOptions): Promise<Torrent> {
        const meta = parseTorrentBuffer(buf);
        return this.addTorrentMeta(meta, options);
    }

    async addTorrentMeta(meta: TorrentMeta, options: TorrentOptions): Promise<Torrent> {
        const torrent = new Torrent({ meta, transport: this.transport, peerId: this.peerId, options });
        this.torrents.add(torrent);
        torrent.once("complete", () => this.torrents.delete(torrent));
        await torrent.start();
        return torrent;
    }

    async close(): Promise<void> {
        for (const t of this.torrents) await t.stop();
        this.torrents.clear();
    }
}

// "-XX0001-" prefix + 12 random bytes (BEP 20 / "Azureus-style").
// Two-letter client code "BT" reserved by no one in particular.
function makePeerId(): Buffer {
    return Buffer.concat([Buffer.from("-BT0001-", "ascii"), crypto.randomBytes(12)]);
}
