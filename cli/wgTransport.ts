import { EventEmitter } from "events";
import { Duplex } from "stream";
import { WireGuardNetwork } from "wireguardnodejs";
import {
    Transport,
    FetchInit,
    FetchResponse,
    ConnectTcpOptions,
    UdpSocketLike,
    TcpListenerLike,
} from "../transport";

// The ONLY Transport the CLI ever constructs. It speaks exclusively through a
// running WireGuardNetwork, so every byte — tracker announces, peer wire
// traffic, inbound seeding — travels inside the tunnel. There is deliberately
// no Node-socket fallback anywhere in the CLI: if the tunnel is down, nothing
// works. That is the whole point.
export class WgTransport implements Transport {
    constructor(private readonly wg: WireGuardNetwork) {}

    fetch(url: string, init?: FetchInit): Promise<FetchResponse> {
        return this.wg.fetch(url, init) as Promise<FetchResponse>;
    }

    async connectTcp(opts: ConnectTcpOptions): Promise<Duplex> {
        return (await this.wg.connectTcp(opts)) as unknown as Duplex;
    }

    openUdp(opts: { port?: number } = {}): UdpSocketLike {
        return new WgUdpSocket(this.wg.openUdp(opts));
    }

    async resolve(hostname: string): Promise<string> {
        const ips = await this.wg.resolve(hostname);
        if (ips.length === 0) throw new Error(`No A records for "${hostname}"`);
        return ips[0];
    }

    async listenTcp(opts: { port?: number } = {}): Promise<TcpListenerLike> {
        // WireGuardTcpListener already exposes port()/close() and emits
        // 'connection' (socket, info) — exactly the TcpListenerLike shape.
        return this.wg.listenTcp(opts) as unknown as TcpListenerLike;
    }
}

// Bridges wireguardnodejs's VirtualUdpSocket (a plain EventEmitter with send /
// close / `port`) to bittorrent's UdpSocketLike (which additionally wants an
// address() method).
class WgUdpSocket extends EventEmitter implements UdpSocketLike {
    constructor(private readonly inner: ReturnType<WireGuardNetwork["openUdp"]>) {
        super();
        inner.on("message", (msg: Buffer, rinfo: { address: string; port: number }) =>
            this.emit("message", msg, rinfo));
        inner.on("error", (err: Error) => this.emit("error", err));
        inner.on("close", () => this.emit("close"));
    }

    send(config: { destIP: string; destPort: number; payload: Buffer }): void {
        this.inner.send(config);
    }

    close(): void {
        this.inner.close();
    }

    address(): { address: string; port: number } {
        return { address: this.wgLocalIp, port: this.inner.port };
    }

    // The tunnel's local IP isn't exposed on the udp socket, but trackers don't
    // rely on our reported source address (they read it off the packet), so a
    // placeholder is fine here.
    private readonly wgLocalIp = "0.0.0.0";
}
