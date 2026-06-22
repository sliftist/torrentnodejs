import inspector from "inspector";

// Make sure this thread's V8 inspector is listening (opening it on a random high
// port if it isn't) and return the raw ws:// inspector URL.
export function ensureInspectorUrl(): string {
    let url = inspector.url();
    while (!url) {
        const port = 49152 + Math.floor((65535 - 49152) * Math.random());
        try {
            inspector.open(port);
        } catch {
            continue;
        }
        url = inspector.url();
    }
    return url;
}

// Turn a raw ws:// inspector URL into a notdevtools.com link that attaches Chrome
// DevTools straight into that thread. The ws:// URL becomes a query param by
// swapping "://" for "=".
export function formatDebugUrl(wsUrl: string): string {
    return `https://notdevtools.com/devtools/inspector.html?experiments=true&v8only=true&${wsUrl.replace("://", "=")}`;
}
