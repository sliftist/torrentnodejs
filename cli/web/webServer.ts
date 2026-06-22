import https from "https";
import { IncomingMessage, ServerResponse } from "http";
import { stringify as stringifyYaml } from "yaml";
import { TorrentManager, TorrentView } from "../torrentManager";
import { SchedulerSettings } from "../config";
import { getOrCreatePassword, passwordMatches } from "./webAuth";
import { getOrCreateCert } from "./webCert";

// Largest slice we serve for a single range request. The browser re-requests
// the rest with serial follow-up ranges, so this bounds per-request memory and
// scheduler load without limiting total playback.
const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

// Plain HTTPS status + file-serving server. Deliberately binds the PUBLIC
// interface (0.0.0.0), outside the WireGuard tunnel, so it can be reached from
// anywhere — the word-password (passed in the `password` query string) is the
// access control. Self-signed TLS and the password both live cached in the
// user's home directory.
//
// Routes (all require ?password=...):
//   GET /                      HTML list of torrents, each linking to its files.
//   GET /torrent/:infoHash     HTML list of that torrent's files: each a download
//                              link plus a "video" button that swaps the page for
//                              a fullscreen autoplaying <video> of that file.
//   GET /status                pretty-printed YAML of every torrent's status.
//   GET /file/:infoHash/:index the file's bytes, with HTTP Range support. Each
//                              range response is capped (the browser re-requests
//                              the rest serially); a bounded range prioritizes
//                              its covered pieces in the scheduler, while a
//                              whole-file pull streams at normal priority.
export class WebCommandServer {
    private readonly manager: TorrentManager;
    private readonly port: number;
    private readonly host: string;
    // Applies edited scheduler settings live AND persists them to the config file
    // (owned by the caller, which holds the Config object).
    private readonly onSchedulerChange: (changes: Partial<SchedulerSettings>) => void;
    private server?: https.Server;
    password = "";

    constructor(config: { manager: TorrentManager; port: number; host?: string; onSchedulerChange: (changes: Partial<SchedulerSettings>) => void }) {
        this.manager = config.manager;
        this.port = config.port;
        this.host = config.host ?? "0.0.0.0";
        this.onSchedulerChange = config.onSchedulerChange;
    }

    async start(): Promise<void> {
        this.password = await getOrCreatePassword();
        const tls = await getOrCreateCert();

        this.server = https.createServer({ cert: tls.cert, key: tls.key }, (req, res) => {
            void this.handle(req, res);
        });

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
        const server = this.server;
        if (!server) return;
        // Force-drop any in-flight file streams; otherwise close() would wait
        // forever on a long-running (or peer-starved) Range request.
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = new URL(req.url || "/", "https://localhost");
        if (!passwordMatches(url.searchParams.get("password"), this.password)) {
            res.writeHead(401, { "content-type": "text/plain" });
            res.end("Authentication required: append ?password=...\n");
            return;
        }

        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length === 0) {
            this.serveTorrents(res);
            return;
        }
        if (parts.length === 1 && parts[0] === "options") {
            if (req.method === "POST") {
                await this.applyOptions(req, res);
                return;
            }
            this.serveOptions(res, url.searchParams.has("saved"));
            return;
        }
        if (parts.length === 1 && parts[0] === "status") {
            this.serveStatus(res);
            return;
        }
        if (parts.length === 2 && parts[0] === "torrent") {
            this.serveTorrentFiles(res, parts[1]);
            return;
        }
        if (parts.length === 3 && parts[0] === "file") {
            await this.serveFile(req, res, parts[1], Number(parts[2]));
            return;
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found\n");
    }

    // Settings page: every scheduler knob as an editable number field. Generic
    // over the settings object so new options (e.g. verifyScanMbps) show up
    // automatically without touching this code.
    private serveOptions(res: ServerResponse, saved: boolean): void {
        const pw = encodeURIComponent(this.password);
        const settings = this.manager.schedulerSettings;
        const fields = Object.entries(settings)
            .map(([key, value]) =>
                `<label style="display:block;margin:8px 0">` +
                `<span style="display:inline-block;width:220px">${escapeHtml(humanizeKey(key))}</span>` +
                `<input type="number" name="${escapeHtml(key)}" value="${escapeHtml(String(value))}" step="any" style="width:160px">` +
                `</label>`
            )
            .join("\n");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(optionsHtml(pw, fields, saved));
    }

    private async applyOptions(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const body = await readBody(req);
        const submitted = new URLSearchParams(body);
        const settings = this.manager.schedulerSettings;
        const changes: Partial<SchedulerSettings> = {};
        for (const key of Object.keys(settings) as (keyof SchedulerSettings)[]) {
            const raw = submitted.get(key);
            if (raw === null || raw === "") continue;
            const num = Number(raw);
            if (!Number.isFinite(num)) continue;
            changes[key] = num;
        }
        this.onSchedulerChange(changes);
        const pw = encodeURIComponent(this.password);
        res.writeHead(303, { location: `/options?password=${pw}&saved=1` });
        res.end();
    }

    private serveStatus(res: ServerResponse): void {
        const views = this.manager.views();
        const status = views.map((v) => statusEntry(v));
        res.writeHead(200, { "content-type": "text/yaml; charset=utf-8" });
        res.end(stringifyYaml({ torrents: status }));
    }

    // Top page: one link per torrent to its files page.
    private serveTorrents(res: ServerResponse): void {
        const pw = encodeURIComponent(this.password);
        const items: string[] = [];
        for (const v of this.manager.views()) {
            const link = `/torrent/${v.infoHash}?password=${pw}`;
            items.push(
                `<li><a href="${escapeHtml(link)}">${escapeHtml(v.name)}</a>` +
                ` (${formatBytes(v.sizeBytes)}, ${(v.progress * 100).toFixed(1)}%)</li>`
            );
        }
        const list = items.length > 0 && items.join("\n") || "<li>(no torrents)</li>";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(torrentsHtml(list, `/options?password=${pw}`));
    }

    // Per-torrent page: each file is a download link plus a "video" button.
    private serveTorrentFiles(res: ServerResponse, infoHash: string): void {
        let files: ReturnType<TorrentManager["torrentFiles"]>;
        try {
            files = this.manager.torrentFiles(infoHash);
        } catch {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Unknown torrent\n");
            return;
        }
        const view = this.manager.views().find((v) => v.infoHash === infoHash);
        const name = view?.name || infoHash;
        const pw = encodeURIComponent(this.password);
        const items: string[] = [];
        for (const f of files) {
            const link = `/file/${infoHash}/${f.index}?password=${pw}`;
            items.push(
                `<li><a href="${escapeHtml(link)}">${escapeHtml(f.path)}</a>` +
                ` (${formatBytes(f.length)}) ` +
                `<button data-name="${escapeHtml(f.path)}" data-src="${escapeHtml(link)}">video</button></li>`
            );
        }
        const list = items.length > 0 && items.join("\n") || "<li>(no files)</li>";
        const back = `/?password=${pw}`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(filesHtml(escapeHtml(name), escapeHtml(back), list));
    }

    private async serveFile(req: IncomingMessage, res: ServerResponse, infoHash: string, fileIndex: number): Promise<void> {
        let files: ReturnType<TorrentManager["torrentFiles"]>;
        try {
            files = this.manager.torrentFiles(infoHash);
        } catch {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Unknown torrent\n");
            return;
        }
        const file = files[fileIndex];
        if (!file) {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("Unknown file\n");
            return;
        }

        const total = file.length;
        const range = parseRange(req.headers["range"], total);
        if (req.headers["range"] && !range) {
            res.writeHead(416, { "content-range": `bytes */${total}` });
            res.end();
            return;
        }

        const start = range?.start ?? 0;
        // Cap how much we serve per range request. A <video>'s first request is
        // usually open-ended (`bytes=0-`); RFC 7233 lets the server return a
        // smaller range than asked, and the browser then issues serial follow-up
        // range requests for the rest (using our Content-Range total). Without
        // this we'd try to stream the whole — possibly multi-GB — file for one
        // request, flooding the scheduler and the client. A request with no Range
        // header at all is a plain download, so it gets the full file (200).
        const endExclusive = range && Math.min(range.endExclusive, start + MAX_RANGE_CHUNK_BYTES) || total;
        const contentType = guessContentType(file.path);
        const headers: Record<string, string> = {
            "content-type": contentType,
            "accept-ranges": "bytes",
            "content-length": String(endExclusive - start),
        };
        if (range) {
            headers["content-range"] = `bytes ${start}-${endExclusive - 1}/${total}`;
            res.writeHead(206, headers);
        } else {
            res.writeHead(200, headers);
        }
        // Push the status + headers to the client immediately. Otherwise Node
        // holds them until the first body byte, which for us can be seconds away
        // (we may have to fetch the covering piece from peers first) — leaving
        // the browser's <video> unsure we even support ranges. Flushing up front
        // tells it "206 + Accept-Ranges + Content-Range" right away so it keeps
        // issuing range requests as it seeks.
        res.flushHeaders();

        let aborted = false;
        req.on("close", () => { aborted = true; });

        try {
            await this.manager.streamFile({
                infoHash,
                fileIndex,
                start,
                endExclusive,
                isAborted: () => aborted || res.writableEnded,
                write: async (chunk) => {
                    if (res.write(chunk)) return;
                    await new Promise<void>((resolve) => res.once("drain", resolve));
                },
            });
        } catch (e) {
            // Headers are already sent, so the best we can do is cut the stream.
            const message = e instanceof Error && e.message || String(e);
            process.stderr.write(`streamFile error: ${message}\n`);
        } finally {
            if (!res.writableEnded) res.end();
        }
    }
}

function statusEntry(v: TorrentView) {
    return {
        name: v.name,
        infoHash: v.infoHash,
        state: v.state,
        progress: `${(v.progress * 100).toFixed(1)}%`,
        scanProgress: v.verifyPiecesToRead > 0 && `${((v.verifyPiecesRead / v.verifyPiecesToRead) * 100).toFixed(1)}%` || undefined,
        scanEtaSeconds: v.verifyEtaMs > 0 && Math.round(v.verifyEtaMs / 1000) || undefined,
        size: formatBytes(v.sizeBytes),
        downloaded: formatBytes(v.downloadedBytes),
        uploaded: formatBytes(v.uploadedBytes),
        downRate: `${formatBytes(v.downRate)}/s`,
        upRate: `${formatBytes(v.upRate)}/s`,
        peers: v.connectedPeers,
        seeders: v.seeders,
        ratio: v.ratio.toFixed(2),
        prioritized: v.prioritized,
        rangeOutstanding: v.rangeOutstanding,
        rangeFinished: v.rangeFinished,
        error: v.error,
    };
}

function parseRange(header: string | undefined, total: number): { start: number; endExclusive: number } | undefined {
    if (!header) return undefined;
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return undefined;
    const startRaw = match[1];
    const endRaw = match[2];
    if (!startRaw && !endRaw) return undefined;
    // Suffix form "bytes=-N": the final N bytes.
    if (!startRaw) {
        const n = Number(endRaw);
        if (n <= 0) return undefined;
        return { start: Math.max(0, total - n), endExclusive: total };
    }
    const start = Number(startRaw);
    if (start >= total) return undefined;
    const endInclusive = endRaw ? Math.min(Number(endRaw), total - 1) : total - 1;
    if (endInclusive < start) return undefined;
    return { start, endExclusive: endInclusive + 1 };
}

const CONTENT_TYPES: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    txt: "text/plain; charset=utf-8",
};

function guessContentType(path: string): string {
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 && path.slice(dot + 1).toLowerCase() || "";
    return CONTENT_TYPES[ext] || "application/octet-stream";
}

function formatBytes(n: number): string {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    const text = unit === 0 && String(value) || value.toFixed(1);
    return `${text} ${units[unit]}`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function torrentsHtml(list: string, optionsLink: string): string {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>torrents</title></head>
<body>
<p><a href="${escapeHtml(optionsLink)}">⚙ options</a></p>
<h2 style="font-size:20px">Torrents</h2>
<ul id="list">
${list}
</ul>
</body>
</html>
`;
}

function optionsHtml(password: string, fields: string, saved: boolean): string {
    const banner = saved && `<p style="color:green">Saved to config file.</p>` || "";
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>options</title></head>
<body>
<p><a href="/?password=${password}">← all torrents</a></p>
<h2 style="font-size:20px">Options</h2>
${banner}
<form method="POST" action="/options?password=${password}">
${fields}
<p><button type="submit">Save</button></p>
</form>
<p style="color:#888">Changes apply live and are written to the config file. Path/port changes still require an app restart.</p>
</body>
</html>
`;
}

function humanizeKey(key: string): string {
    return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim();
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
            size += chunk.length;
            // A settings form is tiny; reject anything implausibly large.
            if (size > 1 << 20) { reject(new Error(`Request body too large (${size} bytes)`)); return; }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

function filesHtml(title: string, back: string, list: string): string {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<p><a href="${back}">← all torrents</a></p>
<h2 style="font-size:20px">${title}</h2>
<ul id="list">
${list}
</ul>
<script>
// Map of file name -> file URL, so a "play" query param can resolve to a src
// even after a refresh re-fetches this list.
var FILES = {};
function playSrc(src) {
    document.body.innerHTML = "";
    document.body.style.margin = "0";
    document.body.style.background = "#000";
    var v = document.createElement("video");
    v.src = src;
    v.autoplay = true;
    v.controls = true;
    v.style.position = "fixed";
    v.style.top = "0";
    v.style.left = "0";
    v.style.width = "100vw";
    v.style.height = "100vh";
    document.body.appendChild(v);
}
function playByName(name) {
    // Record the playing video in the URL (keeping the password) so a refresh
    // resumes it, then play without a full reload.
    var params = new URLSearchParams(location.search);
    params.set("play", name);
    history.replaceState(undefined, "", location.pathname + "?" + params.toString());
    if (FILES[name]) playSrc(FILES[name]);
}
Array.prototype.forEach.call(document.querySelectorAll("button[data-name]"), function (b) {
    FILES[b.getAttribute("data-name")] = b.getAttribute("data-src");
    b.addEventListener("click", function () { playByName(b.getAttribute("data-name")); });
});
(function () {
    var name = new URLSearchParams(location.search).get("play");
    if (name && FILES[name]) playSrc(FILES[name]);
})();
</script>
</body>
</html>
`;
}
