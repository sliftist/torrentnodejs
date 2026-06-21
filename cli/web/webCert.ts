import path from "path";
import { readFile, writeFile, mkdir } from "fs/promises";
import { WEB_STATE_DIR } from "./webAuth";

// selfsigned ships no type declarations; describe just the bit we call.
const selfsigned = require("selfsigned") as {
    generate: (
        attrs: { name: string; value: string }[],
        opts: { days: number; keySize: number; algorithm: string },
    ) => Promise<{ private: string; cert: string }>;
};

const CERT_FILE = path.join(WEB_STATE_DIR, "web-cert.pem");
const KEY_FILE = path.join(WEB_STATE_DIR, "web-key.pem");

export interface TlsMaterial {
    cert: string;
    key: string;
}

// A self-signed cert is generated once and cached in the home directory. It's
// self-signed, so clients connect with verification disabled — the password is
// what actually authorizes access, not the certificate chain.
export async function getOrCreateCert(): Promise<TlsMaterial> {
    const cert = await readFile(CERT_FILE, "utf8").catch(() => undefined);
    const key = await readFile(KEY_FILE, "utf8").catch(() => undefined);
    if (cert && key) return { cert, key };

    const generated = await selfsigned.generate(
        [{ name: "commonName", value: "bittorrent-web-control" }],
        { days: 3650, keySize: 2048, algorithm: "sha256" },
    );
    await mkdir(WEB_STATE_DIR, { recursive: true });
    await writeFile(CERT_FILE, generated.cert, { encoding: "utf8", mode: 0o600 });
    await writeFile(KEY_FILE, generated.private, { encoding: "utf8", mode: 0o600 });
    return { cert: generated.cert, key: generated.private };
}
