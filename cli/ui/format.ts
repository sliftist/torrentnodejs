export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatRate(bytesPerSec: number): string {
    if (bytesPerSec < 1) return "0 B/s";
    return `${formatBytes(bytesPerSec)}/s`;
}

export function formatPercent(p: number): string {
    return `${(p * 100).toFixed(1)}%`;
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
