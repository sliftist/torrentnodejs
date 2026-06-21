// JSON-RPC-ish framing shared by both ends of the web-control WebSocket.
//
// Every packet is a JSON object with a `type`, an `id`, and a `data` payload.
// The common case is type "call": data carries { method, args }; the remote
// runs the matching async function and replies with type "return" (same id) and
// the result in data, or type "error" (same id) with { message }.
//
// An RpcEndpoint is symmetric — the same object both serves incoming calls
// (from its command table) and makes outgoing calls — so a future client can
// reuse it unchanged.

const MAX_ERROR_CHARS = 500;

export interface RpcMessage {
    type: string;
    id: string;
    data?: unknown;
}

export type CommandHandler = (args: unknown) => Promise<unknown>;
export type CommandTable = Record<string, CommandHandler>;

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

export class RpcEndpoint {
    private nextId = 1;
    private readonly pending = new Map<string, Pending>();
    private readonly send: (raw: string) => void;
    private commands: CommandTable;

    constructor(config: { send: (raw: string) => void; commands?: CommandTable }) {
        this.send = config.send;
        this.commands = config.commands ?? {};
    }

    setCommands(commands: CommandTable): void {
        this.commands = commands;
    }

    // Feed every raw text frame from the socket through here.
    async handle(raw: string): Promise<void> {
        let msg: RpcMessage;
        try {
            msg = JSON.parse(raw) as RpcMessage;
        } catch {
            return;
        }
        if (!msg || typeof msg.id !== "string") return;
        if (msg.type === "return") {
            this.settle(msg.id, msg.data, undefined);
            return;
        }
        if (msg.type === "error") {
            const payload = msg.data as { message?: string } | undefined;
            this.settle(msg.id, undefined, new Error(payload?.message ?? "rpc error"));
            return;
        }
        if (msg.type === "call") {
            await this.dispatch(msg);
            return;
        }
    }

    // Make an outgoing call; resolves with the remote's return value.
    call(method: string, args?: unknown): Promise<unknown> {
        const id = String(this.nextId++);
        const promise = new Promise<unknown>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        this.send(JSON.stringify({ type: "call", id, data: { method, args } }));
        return promise;
    }

    // Reject every outstanding call (socket closed).
    rejectAll(reason: string): void {
        for (const [, p] of this.pending) p.reject(new Error(reason));
        this.pending.clear();
    }

    private settle(id: string, value: unknown, err: Error | undefined): void {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        if (err) p.reject(err);
        else p.resolve(value);
    }

    private async dispatch(msg: RpcMessage): Promise<void> {
        const payload = msg.data as { method?: string; args?: unknown } | undefined;
        const method = payload?.method;
        let handler: CommandHandler | undefined;
        if (method) handler = this.commands[method];
        if (!handler) {
            this.send(JSON.stringify({ type: "error", id: msg.id, data: { message: `Unknown method: ${method}` } }));
            return;
        }
        try {
            const result = await handler(payload?.args);
            this.send(JSON.stringify({ type: "return", id: msg.id, data: result }));
        } catch (e) {
            const message = (e as Error).message.slice(0, MAX_ERROR_CHARS);
            this.send(JSON.stringify({ type: "error", id: msg.id, data: { message } }));
        }
    }
}
