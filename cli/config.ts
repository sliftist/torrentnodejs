import { readFile, writeFile, stat, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RunMode } from "../torrent";

export type { RunMode };

export const CONFIG_FILENAME = "bittorrent.config.yaml";

// Cycle order for the in-app mode switch and the canonical list of modes.
export const RUN_MODES: RunMode[] = ["scan", "scrape", "full"];

export const MODE_LABEL: Record<RunMode, string> = {
    scan: "SCAN",
    scrape: "SCRAPE",
    full: "FULL",
};

// One-line explanation shown in the header so the user always knows why
// transfers may not be happening.
export const MODE_DESC: Record<RunMode, string> = {
    scan: "drive scan + hash verify only — NO peers, NO transfers",
    scrape: "scan + scrape trackers for swarm stats — NO upload, NO download",
    full: "all phases — actively downloading and uploading",
};

export function parseRunMode(arg: string | undefined): RunMode {
    const m = (arg || "full").trim().toLowerCase();
    if (m === "scan" || m === "scrape" || m === "full") return m;
    throw new Error(`Unknown mode "${arg}". Expected one of: scan, scrape, full.`);
}

// Global limits from the spec. Every torrent is announced and connects to
// peers; the download SLOTS gate only which torrents actively request blocks,
// while connections/rates/upload-slots are enforced globally across all of them.
export interface SchedulerSettings {
    // Max simultaneous peer connections across every torrent.
    activeConnections: number;
    // Per-torrent peer connection cap.
    connectionsPerTorrent: number;
    // Max torrents actively downloading (requesting blocks) at once.
    downloadSlots: number;
    // Global unchoke (upload) slots shared by all torrents.
    uploadSlots: number;
    // How many of the upload slots rotate randomly (optimistic unchoke).
    optimisticUnchokeSlots: number;
    // Global upload / download rate caps, in megabits per second (0 = unlimited).
    uploadMbps: number;
    downloadMbps: number;
    // A downloading torrent that makes no progress this long may lose its slot
    // to a waiting torrent.
    downloadSkipLimitMs: number;
    // How often the source folders are rescanned for .torrent files (ms).
    watchIntervalMs: number;
}

export interface Config {
    // Path to the WireGuard config file. MANDATORY — the CLI refuses to run
    // without a working tunnel, so this must always be present and valid.
    wireguardConfigPath: string;
    // Where finished/!in-progress torrent *data* is written.
    downloadDir: string;
    // Folders watched for .torrent files appearing/disappearing.
    sources: string[];
    // TCP port we ask WireGuard to listen on for inbound peers (seeding).
    listenPort: number;
    // Public-interface HTTPS port for the web status/file server.
    webPort: number;
    scheduler: SchedulerSettings;
}

export const DEFAULT_SCHEDULER: SchedulerSettings = {
    activeConnections: 500,
    connectionsPerTorrent: 100,
    downloadSlots: 32,
    uploadSlots: 16,
    optimisticUnchokeSlots: 2,
    uploadMbps: 10,
    downloadMbps: 80,
    downloadSkipLimitMs: 5 * 60 * 1000,
    watchIntervalMs: 3000,
};

export function configPath(dir = process.cwd()): string {
    return path.join(dir, CONFIG_FILENAME);
}

export async function configExists(dir = process.cwd()): Promise<boolean> {
    return pathExists(configPath(dir));
}

export async function loadConfig(dir = process.cwd()): Promise<Config> {
    const raw = await readFile(configPath(dir), "utf8");
    const parsed = parseYaml(raw) as Partial<Config> | null;
    if (!parsed || typeof parsed !== "object") {
        throw new Error(`${CONFIG_FILENAME} is empty or malformed`);
    }
    if (!parsed.wireguardConfigPath) throw new Error("config: wireguardConfigPath is required");
    if (!parsed.downloadDir) throw new Error("config: downloadDir is required");
    return {
        wireguardConfigPath: expandHome(parsed.wireguardConfigPath),
        downloadDir: expandHome(parsed.downloadDir),
        sources: (parsed.sources || []).map(expandHome),
        listenPort: parsed.listenPort ?? 6881,
        webPort: parsed.webPort ?? 8443,
        scheduler: { ...DEFAULT_SCHEDULER, ...(parsed.scheduler || {}) },
    };
}

export async function saveConfig(config: Config, dir = process.cwd()): Promise<void> {
    const body = stringifyYaml(config);
    const header =
        "# bittorrent CLI config. Generated automatically; safe to hand-edit.\n" +
        "# This file is gitignored because wireguardConfigPath points at VPN credentials.\n";
    await writeFile(configPath(dir), header + body, "utf8");
}

// ---- validation helpers used by the first-run setup flow ----

export async function validateWireguardPath(p: string): Promise<string> {
    const resolved = expandHome(p.trim());
    const s = await stat(resolved).catch(() => null);
    if (!s || !s.isFile()) throw new Error(`Not a file: ${resolved}`);
    const text = await readFile(resolved, "utf8");
    if (!/\[Interface\]/i.test(text) || !/PrivateKey\s*=/i.test(text)) {
        throw new Error(`${resolved} doesn't look like a WireGuard config ([Interface]/PrivateKey missing)`);
    }
    return resolved;
}

export async function validateDownloadDir(p: string): Promise<string> {
    const resolved = expandHome(p.trim());
    await mkdir(resolved, { recursive: true });
    return resolved;
}

export async function pathExists(p: string): Promise<boolean> {
    return (await stat(p).catch(() => null)) !== null;
}

// Drive-letter (C:\ or C:/) or UNC (\\server\share) absolute path.
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]|^\\\\/;

// Users routinely paste paths that the OS wrapped in quotes (Windows
// "Copy as path" does this) plus stray whitespace. Strip those before any
// path logic, otherwise the leading quote hides the drive letter and the
// path is treated as relative.
export function cleanPathInput(p: string): string {
    let s = p.trim();
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) {
        s = s.slice(1, -1).trim();
    }
    return s;
}

export function expandHome(p: string): string {
    const s = cleanPathInput(p);
    if (s === "~") return os.homedir();
    if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
    // A Windows absolute path is already resolved. Running under posix
    // (e.g. tests on Linux) path.resolve would mistake it for relative and
    // prepend cwd, so return it untouched.
    if (WINDOWS_ABSOLUTE.test(s)) return s;
    return path.resolve(s);
}
