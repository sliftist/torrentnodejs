import https from "https";
import { IncomingMessage, ServerResponse } from "http";
import { stringify as stringifyYaml } from "yaml";
import { TorrentManager, TorrentView } from "../torrentManager";
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
//   GET /                      simple HTML index: each file as a download link
//                              plus a "video" button that swaps the page for a
//                              fullscreen autoplaying <video> of that link.
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
    private server?: https.Server;
    password = "";

    constructor(config: { manager: TorrentManager; port: number; host?: string }) {
        this.manager = config.manager;
        this.port = config.port;
        this.host = config.host ?? "0.0.0.0";
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
            this.serveIndex(res);
            return;
        }
        if (parts.length === 1 && parts[0] === "status") {
            this.serveStatus(res);
            return;
        }
        if (parts.length === 3 && parts[0] === "file") {
            await this.serveFile(req, res, parts[1], Number(parts[2]));
            return;
        }

        res.writeHead(404, { "content-type": "text/plain" });
        res.end("Not found\n");
    }

    private serveStatus(res: ServerResponse): void {
        const views = this.manager.views();
        const status = views.map((v) => statusEntry(v));
        res.writeHead(200, { "content-type": "text/yaml; charset=utf-8" });
        res.end(stringifyYaml({ torrents: status }));
    }

    private serveIndex(res: ServerResponse): void {
        const pw = encodeURIComponent(this.password);
        const items: string[] = [];
        for (const v of this.manager.views()) {
            for (const f of this.manager.torrentFiles(v.infoHash)) {
                const link = `/file/${v.infoHash}/${f.index}?password=${pw}`;
                items.push(
                    `<li><a href="${escapeHtml(link)}">${escapeHtml(f.path)}</a>` +
                    ` (${formatBytes(f.length)}) ` +
                    `<button data-name="${escapeHtml(f.path)}" data-src="${escapeHtml(link)}">video</button></li>`
                );
            }
        }
        const list = items.length > 0 && items.join("\n") || "<li>(no torrents)</li>";
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(indexHtml(list));
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

function indexHtml(list: string): string {
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>torrents</title></head>
<body>
<h2 style="font-size:20px">Torrents</h2>
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
