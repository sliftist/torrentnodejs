import { TorrentManager } from "../torrentManager";
import { CommandTable } from "./protocol";

interface InfoHashArg {
    infoHash: string;
}

interface PrioritizeArg extends InfoHashArg {
    // Defaults to true; pass false to clear prioritization.
    priority?: boolean;
}

interface RequestBlockArg extends InfoHashArg {
    pieceIndex: number;
    begin: number;
    length: number;
}

// The async functions exposed over the web-control RPC. The framework calls
// these by name; each returns a JSON-serializable result.
export function buildCommands(manager: TorrentManager): CommandTable {
    return {
        listTorrents: async () => ({
            aggregate: manager.aggregate(),
            torrents: manager.views(),
        }),

        torrentDetail: async (args) => {
            const { infoHash } = args as InfoHashArg;
            const detail = manager.detail(infoHash);
            if (!detail) throw new Error(`Unknown torrent ${infoHash}`);
            return detail;
        },

        prioritizeTorrent: async (args) => {
            const { infoHash, priority } = args as PrioritizeArg;
            manager.setPriority(infoHash, priority !== false);
            return { infoHash, priority: priority !== false };
        },

        // Resolves only once the block's piece has been downloaded and verified,
        // so a slow torrent simply keeps the caller waiting. The block bytes come
        // back base64-encoded in `data`.
        requestBlock: async (args) => {
            const { infoHash, pieceIndex, begin, length } = args as RequestBlockArg;
            const block = await manager.requestBlock({ infoHash, pieceIndex, begin, length });
            return {
                infoHash,
                pieceIndex,
                begin,
                length: block.length,
                data: block.toString("base64"),
            };
        },
    };
}
