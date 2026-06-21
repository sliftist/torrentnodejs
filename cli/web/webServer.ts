import https from "https";
import { WebSocketServer, WebSocket, RawData } from "ws";
import { TorrentManager } from "../torrentManager";
import { getOrCreatePassword, passwordMatches } from "./webAuth";
import { getOrCreateCert } from "./webCert";
import { RpcEndpoint, CommandTable, RpcMessage } from "./protocol";
import { buildCommands } from "./commands";

// HTTPS + WebSocket command server. Deliberately binds the PUBLIC interface
// (0.0.0.0), outside the WireGuard tunnel, so it can be reached and controlled
// from anywhere — the word-password is the access control. Self-signed TLS and
// password both live cached in the user's home directory.
export class WebCommandServer {
    private readonly manager: TorrentManager;
    private readonly port: number;
    private readonly host: string;
    private server?: https.Server;
    private wss?: WebSocketServer;
    private commands?: CommandTable;
    password = "";

    constructor(config: { manager: TorrentManager; port: number; host?: string }) {
        this.manager = config.manager;
        this.port = config.port;
        this.host = config.host ?? "0.0.0.0";
    }

    async start(): Promise<void> {
        this.password = await getOrCreatePassword();
        const tls = await getOrCreateCert();
        this.commands = buildCommands(this.manager);

        this.server = https.createServer({ cert: tls.cert, key: tls.key });
        this.wss = new WebSocketServer({ server: this.server });
        this.wss.on("connection", (ws) => this.handleConnection(ws));

        const server = this.server;
        await new Promise<void>((resolve, reject) => {
            const onError = (e: Error) => reject(e);
            server.once("error", onError);
            server.listen(this.port, this.host, () => {
                server.off("error", onError);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        for (const client of this.wss?.clients ?? []) {
            try {
                client.terminate();
            } catch {
                /* */
            }
        }
        await new Promise<void>((resolve) => {
            if (!this.wss) return resolve();
            this.wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
            if (!this.server) return resolve();
            this.server.close(() => resolve());
        });
    }

    private handleConnection(ws: WebSocket): void {
        const send = (raw: string) => {
            if (ws.readyState === ws.OPEN) ws.send(raw);
        };
        const endpoint = new RpcEndpoint({ send });
        let authed = false;

        ws.on("message", (raw: RawData) => {
            const text = raw.toString();
            if (!authed) {
                authed = this.tryAuth(text, send);
                if (authed && this.commands) endpoint.setCommands(this.commands);
                return;
            }
            void endpoint.handle(text);
        });
        ws.on("close", () => endpoint.rejectAll("connection closed"));
        ws.on("error", () => endpoint.rejectAll("connection error"));
    }

    // The first frame must be {type:"auth", id, data:{password}}. Wrong or
    // malformed → reject and close; nothing else is processed until authed.
    private tryAuth(text: string, send: (raw: string) => void): boolean {
        let msg: RpcMessage | undefined;
        try {
            msg = JSON.parse(text) as RpcMessage;
        } catch {
            msg = undefined;
        }
        const id = (msg && typeof msg.id === "string") && msg.id || "auth";
        const payload = msg?.data as { password?: unknown } | undefined;
        if (!msg || msg.type !== "auth" || !passwordMatches(payload?.password, this.password)) {
            send(JSON.stringify({ type: "error", id, data: { message: "Authentication required" } }));
            return false;
        }
        send(JSON.stringify({ type: "return", id, data: { ok: true } }));
        return true;
    }
}
