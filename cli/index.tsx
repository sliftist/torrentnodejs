import React from "react";
import { render } from "ink";
import { WireGuardNetwork } from "wireguardnodejs";
import { App } from "./ui/app";
import { TorrentManager } from "./torrentManager";
import { SourceWatcher } from "./watcher";
import { Config, configExists, loadConfig, saveConfig, expandHome, parseRunMode, MODE_LABEL, MODE_DESC } from "./config";
import { runFirstRunSetup } from "./setup";
import { WgTransport } from "./wgTransport";
import { WebCommandServer } from "./web/webServer";

async function main() {
    const mode = parseRunMode(process.argv[2]);
    const config: Config = (await configExists()) ? await loadConfig() : await runFirstRunSetup();

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

    await manager.start();
    watcher.start();

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
        webUrl = `https://<this-host>:${config.webPort}/?password=${encodeURIComponent(webPassword)}`;
        process.stdout.write(`Web control on port ${config.webPort}. Password: ${webPassword}\n`);
    } catch (e) {
        process.stdout.write(`Web control failed to start: ${(e as Error).message}\n`);
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
        />,
        { exitOnCtrlC: false },
    );

    await app.waitUntilExit();

    watcher.stop();
    await webServer.stop();
    await manager.stop();
    wg.close();
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`\nFatal: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
});
