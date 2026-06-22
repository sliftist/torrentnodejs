import { stat, readFile } from "fs/promises";
import { Stats } from "fs";

// Stat a path, returning undefined instead of throwing when it's missing or
// unreadable. Callers that just need "is it there / how big is it" use this
// rather than re-writing the same try/catch at every call site.
export async function tryStat(p: string): Promise<Stats | undefined> {
    try {
        return await stat(p);
    } catch {
        return undefined;
    }
}

export async function pathExists(p: string): Promise<boolean> {
    return Boolean(await tryStat(p));
}

// Read a UTF-8 file, returning undefined instead of throwing when it's missing
// or unreadable — for callers that treat "no file" the same as "empty".
export async function tryReadText(p: string): Promise<string | undefined> {
    try {
        return await readFile(p, "utf8");
    } catch {
        return undefined;
    }
}
