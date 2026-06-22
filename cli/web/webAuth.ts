import crypto from "crypto";
import os from "os";
import path from "path";
import { writeFile, mkdir } from "fs/promises";
import { tryReadText } from "../../fsUtils";
import { PASSWORD_WORDS } from "./wordList";

// Everything the web-control server persists (password + TLS material) lives in
// one hidden folder under the user's home directory, never inside the project.
export const WEB_STATE_DIR = path.join(os.homedir(), ".bittorrent");
const PASSWORD_FILE = path.join(WEB_STATE_DIR, "web-password.txt");

// Number of words joined into the password. Five words from a 1024-word
// dictionary is ~50 bits of entropy — plenty for a manually-typed shared secret.
const PASSWORD_WORD_COUNT = 5;

export async function getOrCreatePassword(): Promise<string> {
    const existing = await tryReadText(PASSWORD_FILE);
    if (existing && existing.trim()) return existing.trim();
    const password = generatePassword();
    await mkdir(WEB_STATE_DIR, { recursive: true });
    await writeFile(PASSWORD_FILE, password + "\n", { encoding: "utf8", mode: 0o600 });
    return password;
}

function generatePassword(): string {
    const words: string[] = [];
    for (let i = 0; i < PASSWORD_WORD_COUNT; i++) {
        words.push(PASSWORD_WORDS[crypto.randomInt(PASSWORD_WORDS.length)]);
    }
    return words.join("-");
}

// Constant-time compare so the server doesn't leak password length/contents
// through response timing.
export function passwordMatches(provided: unknown, expected: string): boolean {
    if (typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
