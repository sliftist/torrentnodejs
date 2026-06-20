import { readFile, writeFile, stat, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RunMode } from "../torrent";

export type { RunMode };

export const CONFIG_FILENAME = "bittorrent.config.yaml";

// Cycle order for the in-app mode switch and the canonical list of modes.
export const RUN_MODES: RunMode[] = ["scan", "connect", "full"];

export const MODE_LABEL: Record<RunMode, string> = {
    scan: "SCAN",
    connect: "CONNECT",
    full: "FULL",
};

// One-line explanation shown in the header so the user always knows why
// transfers may not be happening.
export const MODE_DESC: Record<RunMode, string> = {
    scan: "drive scan + hash verify only — NO peers, NO transfers",
    connect: "scan + find peers/availability — NO upload, NO download",
    full: "all phases — actively downloading and uploading",
};

export function parseRunMode(arg: string | undefined): RunMode {
    const m = (arg || "full").trim().toLowerCase();
    if (m === "scan" || m === "connect" || m === "full") return m;
    throw new Error(`Unknown mode "${arg}". Expected one of: scan, connect, full.`);
}

// qBittorrent-style scheduler knobs. Defaults mirror its out-of-the-box caps.
export interface SchedulerSettings {
    // Max torrents actively downloading at once.
    maxActiveDownloads: number;
    // Max torrents actively seeding (uploading) at once.
    maxActiveSeeds: number;
    // Overall cap on active (downloading + seeding) torrents.
    maxActiveTotal: number;
    // Per-torrent peer connection cap.
    maxPeersPerTorrent: number;
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
    scheduler: SchedulerSettings;
}

export const DEFAULT_SCHEDULER: SchedulerSettings = {
    maxActiveDownloads: 3,
    maxActiveSeeds: 5,
    maxActiveTotal: 8,
    maxPeersPerTorrent: 40,
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
