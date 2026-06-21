import React from "react";
import { Box, Text } from "ink";
import { TorrentDetail, TorrentView } from "../torrentManager";
import { formatBytes, formatRate, formatPercent, formatEta, progressBar, truncate } from "./format";

export const DETAIL_TABS = ["general", "peers", "trackers", "pieces", "files"] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

export function DetailView(props: {
    view: TorrentView;
    detail: TorrentDetail;
    tab: DetailTab;
    scroll: number;
    width: number;
    height: number;
}) {
    const { view, detail, tab, scroll, width, height } = props;
    const bodyHeight = Math.max(3, height - 4);

    return (
        <Box flexDirection="column" width={width}>
            <Box>
                <Text bold color="cyan">{truncate(detail.name, width - 2)}</Text>
            </Box>
            <Box>
                {DETAIL_TABS.map((t) => (
                    <Text key={t} color={t === tab ? "black" : "gray"} backgroundColor={t === tab ? "cyan" : undefined}>
                        {` ${t} `}
                    </Text>
                ))}
                <Text dimColor>  (Tab/⇧Tab tabs · ↑↓ scroll · a actions · ← back)</Text>
            </Box>
            <Box flexDirection="column" height={bodyHeight} marginTop={1}>
                {renderTab(tab, view, detail, scroll, bodyHeight, width)}
            </Box>
        </Box>
    );
}

function renderTab(tab: DetailTab, view: TorrentView, detail: TorrentDetail, scroll: number, rows: number, width: number) {
    switch (tab) {
        case "general": return <GeneralTab view={view} detail={detail} />;
        case "peers": return <PeersTab detail={detail} scroll={scroll} rows={rows} width={width} />;
        case "trackers": return <TrackersTab detail={detail} scroll={scroll} rows={rows} width={width} />;
        case "pieces": return <PiecesTab detail={detail} width={width} rows={rows} />;
        case "files": return <FilesTab detail={detail} scroll={scroll} rows={rows} width={width} />;
    }
}

function GeneralTab(props: { view: TorrentView; detail: TorrentDetail }) {
    const { view, detail } = props;
    const rows: [string, string][] = [
        ["State", view.state],
        ["Info hash", view.infoHash],
        ["Progress", `${formatPercent(view.progress)}  ${progressBar(view.progress, 30)}`],
        ["Size", formatBytes(view.sizeBytes)],
        ["Downloaded", formatBytes(view.downloadedBytes)],
        ["Uploaded", formatBytes(view.uploadedBytes)],
        ["Down rate", formatRate(view.downRate)],
        ["Up rate", formatRate(view.upRate)],
        ["ETA", formatEta(view.etaSeconds)],
        ["Ratio", view.ratio.toFixed(2)],
        ["Peers", `${view.connectedPeers} connected · ${view.seeders} seeders / ${view.swarmPeers} in swarm`],
        ["Unchoke", `${view.peersUnchokingUs} unchoking us · ${view.peersWeUnchoked} we unchoked`],
        ["Trackers", `${view.trackersResponding} / ${view.trackersTotal} responding`],
        ["Pieces", `${detail.pieceCounts.done} done / ${detail.pieceCounts.downloading} active / ${detail.pieceCounts.needed} needed`],
        ["Source", view.sourcePath],
    ];
    if (view.error) rows.push(["Error", view.error]);
    return (
        <Box flexDirection="column">
            {rows.map(([k, v]) => (
                <Box key={k}>
                    <Box width={14}><Text dimColor>{k}</Text></Box>
                    <Text>{v}</Text>
                </Box>
            ))}
        </Box>
    );
}

function PeersTab(props: { detail: TorrentDetail; scroll: number; rows: number; width: number }) {
    const { detail, scroll, rows } = props;
    if (detail.peers.length === 0) return <Text dimColor>No connected peers.</Text>;
    const slice = detail.peers.slice(scroll, scroll + rows);
    return (
        <Box flexDirection="column">
            <Box>
                <Box width={24}><Text dimColor bold>address</Text></Box>
                <Box width={6}><Text dimColor bold>dir</Text></Box>
                <Box width={12}><Text dimColor bold>peer-choke</Text></Box>
                <Box width={12}><Text dimColor bold>am-choke</Text></Box>
                <Text dimColor bold>inflight</Text>
            </Box>
            {slice.map((p, i) => (
                <Box key={`${p.ip}:${p.port}:${i}`}>
                    <Box width={24}><Text>{`${p.ip}:${p.port}`}</Text></Box>
                    <Box width={6}><Text color={p.direction === "in" ? "green" : "yellow"}>{p.direction}</Text></Box>
                    <Box width={12}><Text>{p.peerChoking ? "choked" : "unchoked"}</Text></Box>
                    <Box width={12}><Text>{p.amChoking ? "choked" : "unchoked"}</Text></Box>
                    <Text>{String(p.inflight)}</Text>
                </Box>
            ))}
        </Box>
    );
}

function TrackersTab(props: { detail: TorrentDetail; scroll: number; rows: number; width: number }) {
    const { detail, scroll, rows, width } = props;
    if (detail.trackers.length === 0) return <Text dimColor>No trackers.</Text>;
    const slice = detail.trackers.slice(scroll, scroll + rows);
    return (
        <Box flexDirection="column">
            {slice.map((t, i) => (
                <Box key={`${t.url}:${i}`} flexDirection="column">
                    <Text>
                        <Text color={statusColor(t.status)}>{`[${t.status}]`}</Text>
                        {" "}
                        {truncate(t.url, width - 12)}
                    </Text>
                    <Text dimColor>
                        {t.status === "error"
                            ? `   ${t.error ?? "error"}`
                            : `   seeders=${t.seeders ?? "?"} leechers=${t.leechers ?? "?"} peers=${t.peers ?? "?"}`}
                    </Text>
                </Box>
            ))}
        </Box>
    );
}

function PiecesTab(props: { detail: TorrentDetail; width: number; rows: number }) {
    const { detail, width, rows } = props;
    const states = detail.pieceStates;
    if (states.length === 0) return <Text dimColor>Piece map available once the torrent is active.</Text>;
    const perRow = Math.max(8, width - 2);
    const lines: React.ReactNode[] = [];
    for (let r = 0; r < rows && r * perRow < states.length; r++) {
        const chunk = states.slice(r * perRow, (r + 1) * perRow);
        lines.push(
            <Text key={r}>
                {chunk.map((s, i) => (
                    <Text key={i} color={s === "done" ? "green" : s === "downloading" ? "yellow" : "gray"}>
                        {s === "done" ? "█" : s === "downloading" ? "▒" : "░"}
                    </Text>
                ))}
            </Text>,
        );
    }
    return (
        <Box flexDirection="column">
            {lines}
            <Box marginTop={1}>
                <Text dimColor>
                    <Text color="green">█</Text> done  <Text color="yellow">▒</Text> downloading  <Text color="gray">░</Text> needed
                </Text>
            </Box>
        </Box>
    );
}

function FilesTab(props: { detail: TorrentDetail; scroll: number; rows: number; width: number }) {
    const { detail, scroll, rows, width } = props;
    const slice = detail.files.slice(scroll, scroll + rows);
    return (
        <Box flexDirection="column">
            {slice.map((f, i) => (
                <Box key={`${f.path}:${i}`}>
                    <Box width={12}><Text dimColor>{formatBytes(f.length)}</Text></Box>
                    <Text>{truncate(f.path, width - 14)}</Text>
                </Box>
            ))}
        </Box>
    );
}

function statusColor(status: string): string {
    if (status === "ok") return "green";
    if (status === "error") return "red";
    if (status === "unsupported") return "gray";
    return "yellow";
}
