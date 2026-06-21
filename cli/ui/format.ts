// Compact human number with K/M/G/T suffixes and at most a couple of decimals
// (fewer as the integer part grows), trailing zeros trimmed. Keeps EMA floats
// like 523.7283938 from blowing out a fixed-width column.
export function formatNumber(n: number): string {
    if (!isFinite(n)) return "0";
    const neg = n < 0;
    let v = Math.abs(n);
    const units = ["", "K", "M", "G", "T", "P"];
    let i = 0;
    while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
    let decimals = 2;
    if (v >= 100) decimals = 0;
    else if (v >= 10) decimals = 1;
    let s = v.toFixed(decimals);
    if (s.includes(".")) s = s.replace(/\.?0+$/, "");
    return (neg ? "-" : "") + s + units[i];
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${Math.round(n)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1) return "0 B/s";
    return `${formatNumber(bytesPerSec)}B/s`;
}

export function formatPercent(p: number): string {
    return `${(p * 100).toFixed(1)}%`;
}

export function formatEta(seconds: number): string {
    if (!isFinite(seconds)) return "∞";
    if (seconds <= 0) return "0s";
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

// Compact local "MM-DD HH:mm" timestamp from epoch milliseconds; "—" when the
// time is unknown (0 / not yet determined).
export function formatDateTime(ms: number): string {
    if (!ms || !isFinite(ms)) return "—";
    const d = new Date(ms);
    const p = (n: number) => n.toString().padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Normalize for filtering: keep only [a-z0-9], lowercased. Spaces and special
// characters are dropped so "Big Buck Bunny!" matches "bigbuck".
export function normalizeForFilter(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function progressBar(p: number, width: number): string {
    const filled = Math.round(Math.max(0, Math.min(1, p)) * width);
    return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    if (max <= 1) return s.slice(0, max);
    return s.slice(0, max - 1) + "…";
}
