import { readdir } from "fs/promises";
import path from "path";
import { loadConfig } from "../cli/config";
import { parseTorrentFile, TorrentMeta, pieceLengthAt } from "../torrentFile";
import { Storage } from "../storage";

// Locates the file a given piece starts in and where the piece falls within
// that file's own run of chunks, so a mismatch can be reported as
// "chunk N of M in <file>" rather than just a global piece index.
function locatePiece(meta: TorrentMeta, pieceIndex: number) {
    const pieceStart = pieceIndex * meta.pieceLength;
    for (const f of meta.files) {
        if (f.length === 0) continue;
        if (pieceStart < f.offsetInTorrent || pieceStart >= f.offsetInTorrent + f.length) continue;
        const firstPiece = Math.floor(f.offsetInTorrent / meta.pieceLength);
        const lastPiece = Math.floor((f.offsetInTorrent + f.length - 1) / meta.pieceLength);
        return {
            file: f.path.join("/"),
            indexInFile: pieceIndex - firstPiece + 1,
            chunksInFile: lastPiece - firstPiece + 1,
        };
    }
    return { file: "(unknown)", indexInFile: 0, chunksInFile: 0 };
}

async function findTorrentFiles(folders: string[]): Promise<string[]> {
    const found: string[] = [];
    for (const folder of folders) {
        let entries: string[];
        try {
            entries = await readdir(folder);
        } catch {
            console.warn(`! cannot read source folder ${folder}`);
            continue;
        }
        for (const name of entries) {
            if (!name.toLowerCase().endsWith(".torrent")) continue;
            found.push(path.join(folder, name));
        }
    }
    return found;
}

async function main() {
    const filter = (process.argv[2] || "").toLowerCase();
    if (!filter) throw new Error("Usage: yarn check <filter>  (case-insensitive substring of the torrent name)");

    const config = await loadConfig();
    const torrentPaths = await findTorrentFiles(config.sources);

    const matched: { path: string; meta: TorrentMeta }[] = [];
    for (const p of torrentPaths) {
        const meta = await parseTorrentFile(p).catch((e: Error) => {
            console.warn(`! failed to parse ${p}: ${e.message}`);
            return undefined;
        });
        if (!meta) continue;
        if (!meta.name.toLowerCase().includes(filter)) continue;
        matched.push({ path: p, meta });
    }

    if (matched.length === 0) {
        console.log(`No torrents matched "${filter}".`);
        return;
    }
    console.log(`Checking ${matched.length} torrent(s) matching "${filter}" in ${config.downloadDir}\n`);

    let totalMismatched = 0;
    for (const { meta } of matched) {
        const total = meta.pieceHashes.length;
        console.log(`=== ${meta.name}  (${total} chunks, ${meta.files.length} file(s)) ===`);
        // Empty touched-pieces set: verify reads whatever is on disk without
        // allocating any temp files (this is a read-only check).
        const storage = new Storage(meta, config.downloadDir, new Set());
        await storage.open();
        let mismatched = 0;
        const have = await storage.verifyExistingPieces(
            meta.pieceHashes.map((_, i) => i),
            {
                onMismatch: ({ index, computed, expected }) => {
                    mismatched++;
                    const loc = locatePiece(meta, index);
                    console.log(
                        `  MISMATCH chunk ${loc.indexInFile}/${loc.chunksInFile} in ${loc.file} ` +
                        `(global piece ${index}/${total})\n` +
                        `    expected ${expected.toString("hex")}\n` +
                        `    received ${computed.toString("hex")}`,
                    );
                },
            },
        );
        await storage.close();
        totalMismatched += mismatched;
        const ok = have.popcount();
        // Pieces that are neither verified nor a content mismatch have no file
        // on disk backing them — they're simply absent.
        const missing = total - ok - mismatched;
        console.log(`  ${ok}/${total} chunks verified, ${mismatched} mismatched, ${missing} missing\n`);
    }
    console.log(`Done. ${totalMismatched} mismatched chunk(s) across ${matched.length} torrent(s).`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
