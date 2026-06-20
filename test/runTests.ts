import { runBencodeTests } from "./bencodeTests";
import { runTorrentFileTests } from "./torrentFileTests";
import { runBitfieldTests } from "./bitfieldTests";
import { runPieceManagerTests } from "./pieceManagerTests";
import { runStorageTests } from "./storageTests";

async function main() {
    await runBencodeTests();
    await runTorrentFileTests();
    await runBitfieldTests();
    await runPieceManagerTests();
    await runStorageTests();
    console.log("All tests passed.");
}
main().catch((e) => { console.error(e); process.exit(1); });
