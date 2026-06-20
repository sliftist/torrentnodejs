import { readFile, writeFile, stat, mkdir } from "fs/promises";
import path from "path";
import os from "os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export const CONFIG_FILENAME = "bittorrent.config.yaml";

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

export function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return path.resolve(p);
}
