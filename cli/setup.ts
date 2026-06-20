import * as readline from "readline/promises";
import { stdin, stdout } from "process";
import {
    Config,
    DEFAULT_SCHEDULER,
    saveConfig,
    validateWireguardPath,
    validateDownloadDir,
} from "./config";

// Interactive first-run setup. Runs once, before the TUI starts, when no
// config file exists. WireGuard is mandatory, so we ask for (and validate) its
// config path FIRST — there is no way to skip it. Then the download directory.
// Watched source folders are added later by pasting paths into the running TUI.
export async function runFirstRunSetup(): Promise<Config> {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
        stdout.write("\nFirst-run setup — this client only works through WireGuard.\n\n");

        const wireguardConfigPath = await promptUntilValid(
            rl,
            "Path to your WireGuard config file: ",
            validateWireguardPath,
        );

        const downloadDir = await promptUntilValid(
            rl,
            "Directory to download torrent data into: ",
            validateDownloadDir,
        );

        const config: Config = {
            wireguardConfigPath,
            downloadDir,
            sources: [],
            listenPort: 6881,
            scheduler: { ...DEFAULT_SCHEDULER },
        };
        await saveConfig(config);
        stdout.write(`\nSaved config. Paste source folder paths into the app to start watching them.\n\n`);
        return config;
    } finally {
        rl.close();
    }
}

async function promptUntilValid(
    rl: readline.Interface,
    question: string,
    validate: (input: string) => Promise<string>,
): Promise<string> {
    for (;;) {
        const answer = (await rl.question(question)).trim();
        if (!answer) {
            stdout.write("  (required)\n");
            continue;
        }
        try {
            return await validate(answer);
        } catch (e) {
            stdout.write(`  ${(e as Error).message}\n`);
        }
    }
}
