import React from "react";
import { render } from "ink";
import { WireGuardNetwork } from "wireguardnodejs";
import { App } from "./ui/app";
import { TorrentManager } from "./torrentManager";
import { SourceWatcher } from "./watcher";
import { Config, configExists, loadConfig, saveConfig, expandHome } from "./config";
import { runFirstRunSetup } from "./setup";
import { WgTransport } from "./wgTransport";

async function main() {
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
        listenPortBase: config.listenPort,
    });

    const watcher = new SourceWatcher({
        intervalMs: config.scheduler.watchIntervalMs,
        onAdd: (p) => void manager.addSourceFile(p),
        onRemove: (p) => void manager.removeSourceFile(p),
    });
    watcher.setFolders(config.sources);

    await manager.start();
    watcher.start();

    const onAddSource = (folder: string) => {
        const resolved = expandHome(folder);
        if (!config.sources.includes(resolved)) {
            config.sources.push(resolved);
            void saveConfig(config);
        }
        watcher.addFolder(resolved);
    };

    const app = render(
        <App manager={manager} watcher={watcher} localIP={wg.localIP} onAddSource={onAddSource} />,
        { exitOnCtrlC: false },
    );

    await app.waitUntilExit();

    watcher.stop();
    await manager.stop();
    wg.close();
    process.exit(0);
}

main().catch((e) => {
    process.stderr.write(`\nFatal: ${(e as Error).stack || (e as Error).message}\n`);
    process.exit(1);
});
