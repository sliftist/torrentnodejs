import React from "react";
import { render } from "ink";
import inspector from "inspector";
import path from "path";
import { copyFile, rename, mkdir } from "fs/promises";
import { WireGuardNetwork } from "wireguardnodejs";
import { App } from "./ui/app";
import { TorrentManager } from "./torrentManager";
import { SourceWatcher } from "./watcher";
import { Config, configExists, loadConfig, saveConfig, expandHome, pathExists, parseRunMode, MODE_LABEL, MODE_DESC } from "./config";
import { runFirstRunSetup } from "./setup";
import { WgTransport } from "./wgTransport";
import { WebCommandServer } from "./web/webServer";

// Mirrors the debugbreak library: make sure the V8 inspector is listening
// (opening it on a random high port if it isn't) and build a notdevtools.com
// URL that attaches Chrome DevTools to this running process — clickable straight
// into a debugger. The ws:// inspector URL becomes a query param by swapping
// "://" for "=".
function inspectorDebugUrl(): string {
    let url = inspector.url();
    while (!url) {
        const port = 49152 + Math.floor((65535 - 49152) * Math.random());
        try {
            inspector.open(port);
        } catch {
            continue;
        }
        url = inspector.url();
    }
    return `https://notdevtools.com/devtools/inspector.html?experiments=true&v8only=true&${url.replace("://", "=")}`;
}

async function ingestCopySource(torrentPath: string, copyDest: string | undefined, manager: TorrentManager): Promise<void> {
    // Without a regular source to archive into, just load it in place.
    if (!copyDest) {
        await manager.addSourceFile(torrentPath);
        return;
    }
    await mkdir(copyDest, { recursive: true });
    const dest = path.join(copyDest, path.basename(torrentPath));
    if (!(await pathExists(dest))) {
        const tmp = path.join(copyDest, `.${path.basename(torrentPath)}.tmp`);
        await copyFile(torrentPath, tmp);
        await rename(tmp, dest);
    }
    await manager.addSourceFile(dest);
}

async function main() {
    const mode = parseRunMode(process.argv[2]);
    const existed = await configExists();
    const config: Config = existed ? await loadConfig() : await runFirstRunSetup();
    // Persist immediately so every limit — including ones left at their default
    // or absent from an older config — is written out for hand-editing. (First
    // run already saved; only re-save when loading an existing file.)
    if (existed) await saveConfig(config);

    // Bring up the tunnel. This is the ONLY network path the client has — if it
    // fails, we exit rather than silently falling back to the host network.
    process.stdout.write(`Connecting to WireGuard (${config.wireguardConfigPath})...\n`);
    const wg = await WireGuardNetwork.fromConfigFile(config.wireguardConfigPath);
    await wg.start();
    process.stdout.write(`Tunnel up. Internal IP ${wg.localIP}.\n`);

    const transport = new WgTransport(wg);
    const manager = new TorrentManager({
        transport,
        downloadDir: config.downloadDir,
        scheduler: config.scheduler,
        listenPort: config.listenPort,
        mode,
    });
    process.stdout.write(`Run mode: ${MODE_LABEL[mode]} — ${MODE_DESC[mode]}.\n`);

    const watcher = new SourceWatcher({
        intervalMs: config.scheduler.watchIntervalMs,
        onAdd: (p) => void manager.addSourceFile(p),
        onRemove: (p) => void manager.removeSourceFile(p),
    });
    watcher.setFolders(config.sources);

    // Copy sources are a separate location scanned continuously after startup.
    // Anything found is archived into the first regular source (write-temp then
    // rename so a partial copy is never observed) and then loaded, so deleting
    // the original from the copy source can't lose the torrent.
    const copyDest = config.sources[0];
    const copyWatcher = new SourceWatcher({
        intervalMs: config.scheduler.watchIntervalMs,
        onAdd: (p) => void ingestCopySource(p, copyDest, manager),
        onRemove: () => {},
    });
    copyWatcher.setFolders(config.copySources);

    await manager.start();
    watcher.start();
    copyWatcher.start();

    // Public-interface HTTPS status/file server. This is the one component
    // allowed to listen and talk OUTSIDE the WireGuard tunnel; the word-password
    // (cached in ~/.bittorrent, passed in the ?password= query string) gates
    // every request.
    const webServer = new WebCommandServer({ manager, port: config.webPort });
    let webUrl: string | undefined;
    let webPassword: string | undefined;
    try {
        await webServer.start();
        webPassword = webServer.password;
        webUrl = `https://localhost:${config.webPort}/?password=${encodeURIComponent(webPassword)}`;
        process.stdout.write(`Web control on port ${config.webPort}. Password: ${webPassword}\n`);
    } catch (e) {
        process.stdout.write(`Web control failed to start: ${(e as Error).message}\n`);
    }

    let debugUrl: string | undefined;
    try {
        debugUrl = inspectorDebugUrl();
    } catch (e) {
        process.stdout.write(`Debugger URL unavailable: ${(e as Error).message}\n`);
    }

    const onAddSource = (folder: string) => {
        const resolved = expandHome(folder);
        if (!config.sources.includes(resolved)) {
            config.sources.push(resolved);
            void saveConfig(config);
        }
        watcher.addFolder(resolved);
    };

    const onSchedulerChange = (changes: Partial<typeof config.scheduler>) => {
        manager.updateScheduler(changes);
        if (changes.watchIntervalMs) watcher.setIntervalMs(changes.watchIntervalMs);
        config.scheduler = { ...config.scheduler, ...changes };
        void saveConfig(config);
    };

    const app = render(
        <App
            manager={manager}
            watcher={watcher}
            localIP={wg.localIP}
            onAddSource={onAddSource}
            onSchedulerChange={onSchedulerChange}
            webUrl={webUrl}
            webPassword={webPassword}
            debugUrl={debugUrl}
        />,
        { exitOnCtrlC: false },
    );

    await app.waitUntilExit();

    watcher.stop();
    copyWatcher.stop();
    await webServer.stop();
    await manager.stop();
    wg.close();
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`\nFatal: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
});
