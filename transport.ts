import { EventEmitter } from "events";
import { Duplex } from "stream";
import dgram from "dgram";
import net from "net";
import http from "http";
import https from "https";
import dns from "dns";

// Minimal networking surface used by the BitTorrent client. The shape matches
// what wireguardnodejs's WireGuardNetwork already exposes, so swapping in the
// WireGuard tunnel later is a one-line change.

export interface FetchInit {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    timeoutMs?: number;
}

export interface FetchResponse {
    status: number;
    statusText: string;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    text(): string;
    json(): unknown;
}

export interface UdpRemoteInfo {
    address: string;
    port: number;
}

export interface UdpSocketLike extends EventEmitter {
    send(config: { destIP: string; destPort: number; payload: Buffer }): void;
    close(): void;
    address(): { address: string; port: number };
    // emits 'message' (msg: Buffer, rinfo: UdpRemoteInfo)
    // emits 'error' (err: Error)
    // emits 'close'
}

export interface ConnectTcpOptions {
    host: string;
    port: number;
}

export interface TcpListenerLike extends EventEmitter {
    close(): void;
    port(): number;
    // emits 'connection' (socket: Duplex, info: { remoteAddress: string; remotePort: number })
    // emits 'close'
    // emits 'error' (err: Error)
}

export interface Transport {
    fetch(url: string, init?: FetchInit): Promise<FetchResponse>;
    connectTcp(opts: ConnectTcpOptions): Promise<Duplex>;
    openUdp(opts?: { port?: number }): UdpSocketLike;
    // Resolve a hostname to a single IPv4 address. Used by code paths that
    // need an IP up front (UDP sockets only accept dotted-quad destinations).
    resolve(hostname: string): Promise<string>;
    // Bind a TCP listener so peers can connect TO us for seeding.
    listenTcp(opts?: { port?: number; address?: string }): Promise<TcpListenerLike>;
}

export class NodeTransport implements Transport {
    async fetch(url: string, init: FetchInit = {}): Promise<FetchResponse> {
        const u = new URL(url);
        const isHttps = u.protocol === "https:";
        if (!isHttps && u.protocol !== "http:") {
            throw new Error(`Unsupported scheme "${u.protocol}" for ${url}`);
        }
        const port = u.port ? parseInt(u.port, 10) : (isHttps ? 443 : 80);
        const requestFn = isHttps ? https.request : http.request;
        const baseHeaders: Record<string, string> = {
            Host: u.hostname + (u.port ? `:${u.port}` : ""),
            Connection: "close",
            ...(init.headers || {}),
        };
        const bodyBuf = init.body && typeof init.body === "string" ? Buffer.from(init.body) : (init.body as Buffer | undefined);
        if (bodyBuf && baseHeaders["Content-Length"] === undefined) {
            baseHeaders["Content-Length"] = String(bodyBuf.length);
        }

        return new Promise<FetchResponse>((resolve, reject) => {
            const req = requestFn({
                host: u.hostname,
                port,
                method: init.method || "GET",
                path: (u.pathname || "/") + u.search,
                headers: baseHeaders,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => {
                    const body = Buffer.concat(chunks);
                    resolve({
                        status: res.statusCode || 0,
                        statusText: res.statusMessage || "",
                        headers: res.headers,
                        body,
                        text: () => body.toString(),
                        json: () => JSON.parse(body.toString()),
                    });
                });
                res.on("error", reject);
            });
            if (init.timeoutMs) {
                req.setTimeout(init.timeoutMs, () => req.destroy(new Error(`fetch ${url} timed out after ${init.timeoutMs}ms`)));
            }
            req.on("error", reject);
            if (bodyBuf) req.write(bodyBuf);
            req.end();
        });
    }

    connectTcp(opts: ConnectTcpOptions): Promise<Duplex> {
        return new Promise<Duplex>((resolve, reject) => {
            const sock = net.createConnection({ host: opts.host, port: opts.port });
            const onError = (err: Error) => { sock.removeAllListeners("connect"); reject(err); };
            sock.once("error", onError);
            sock.once("connect", () => {
                sock.removeListener("error", onError);
                resolve(sock);
            });
        });
    }

    openUdp(opts: { port?: number } = {}): UdpSocketLike {
        const sock = dgram.createSocket("udp4");
        sock.bind(opts.port || 0);
        return new NodeUdpSocket(sock);
    }

    async resolve(hostname: string): Promise<string> {
        if (isIPv4(hostname)) return hostname;
        const { address } = await dns.promises.lookup(hostname, { family: 4 });
        return address;
    }

    async listenTcp(opts: { port?: number; address?: string } = {}): Promise<TcpListenerLike> {
        const server = net.createServer();
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(opts.port || 0, opts.address || "0.0.0.0", () => {
                server.removeListener("error", reject);
                resolve();
            });
        });
        return new NodeTcpListener(server);
    }
}

class NodeTcpListener extends EventEmitter implements TcpListenerLike {
    constructor(private readonly server: net.Server) {
        super();
        server.on("connection", (sock) => {
            this.emit("connection", sock, {
                remoteAddress: sock.remoteAddress || "0.0.0.0",
                remotePort: sock.remotePort || 0,
            });
        });
        server.on("error", (err) => this.emit("error", err));
        server.on("close", () => this.emit("close"));
    }
    close(): void { this.server.close(); }
    port(): number {
        const a = this.server.address();
        if (a && typeof a !== "string") return a.port;
        return 0;
    }
}

class NodeUdpSocket extends EventEmitter implements UdpSocketLike {
    constructor(private readonly inner: dgram.Socket) {
        super();
        inner.on("message", (msg, rinfo) =>
            this.emit("message", msg, { address: rinfo.address, port: rinfo.port }));
        inner.on("error", (err) => this.emit("error", err));
        inner.on("close", () => this.emit("close"));
    }
    send(config: { destIP: string; destPort: number; payload: Buffer }): void {
        this.inner.send(config.payload, config.destPort, config.destIP);
    }
    close(): void { this.inner.close(); }
    address(): { address: string; port: number } {
        const a = this.inner.address();
        return { address: a.address, port: a.port };
    }
}

function isIPv4(s: string): boolean {
    const parts = s.split(".");
    if (parts.length !== 4) return false;
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (Number.isNaN(n) || n < 0 || n > 255 || String(n) !== p) return false;
    }
    return true;
}
