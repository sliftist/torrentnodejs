import { EventEmitter } from "events";
import { readdir, stat } from "fs/promises";
import path from "path";

export interface SourceWatcherOptions {
    intervalMs: number;
    // Called with absolute paths as .torrent files appear / disappear across
    // the union of all watched folders.
    onAdd: (torrentPath: string) => void;
    onRemove: (torrentPath: string) => void;
}

// Polling watcher (no fs.watch — it's unreliable across platforms and network
// mounts). Each tick it rescans every watched folder for *.torrent files and
// diffs against the previous scan. Folders can be added/removed at runtime.
export class SourceWatcher extends EventEmitter {
    private readonly intervalMs: number;
    private readonly onAdd: (p: string) => void;
    private readonly onRemove: (p: string) => void;
    private folders = new Set<string>();
    private known = new Set<string>();
    private timer?: NodeJS.Timeout;
    private scanning = false;

    constructor(opts: SourceWatcherOptions) {
        super();
        this.intervalMs = opts.intervalMs;
        this.onAdd = opts.onAdd;
        this.onRemove = opts.onRemove;
    }

    setFolders(folders: string[]): void {
        this.folders = new Set(folders.map((f) => path.resolve(f)));
        // Kick an immediate scan so newly-added folders are picked up promptly.
        void this.scan();
    }

    addFolder(folder: string): void {
        this.folders.add(path.resolve(folder));
        void this.scan();
    }

    get watchedFolders(): string[] {
        return [...this.folders];
    }

    start(): void {
        if (this.timer) return;
        void this.scan();
        this.timer = setInterval(() => void this.scan(), this.intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private async scan(): Promise<void> {
        if (this.scanning) return;
        this.scanning = true;
        try {
            const current = new Set<string>();
            for (const folder of this.folders) {
                let entries: string[];
                try {
                    entries = await readdir(folder);
                } catch (e) {
                    this.emit("folder-error", { folder, error: e });
                    continue;
                }
                for (const name of entries) {
                    if (!name.toLowerCase().endsWith(".torrent")) continue;
                    const full = path.join(folder, name);
                    const s = await stat(full).catch(() => null);
                    if (s && s.isFile()) current.add(full);
                }
            }
            for (const p of current) if (!this.known.has(p)) this.onAdd(p);
            for (const p of this.known) if (!current.has(p)) this.onRemove(p);
            this.known = current;
        } finally {
            this.scanning = false;
        }
    }
}
