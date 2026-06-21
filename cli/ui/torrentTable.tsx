import React from "react";
import { Box, Text } from "ink";
import { TorrentSection, TorrentView } from "../torrentManager";
import { formatRate, formatPercent, formatEta, formatNumber, formatBytes, formatDateTime, truncate } from "./format";

const STATE_COLOR: Record<string, string> = {
    queued: "gray",
    checking: "blue",
    checked: "blue",
    corrupted: "red",
    ready: "magenta",
    downloading: "cyan",
    seeding: "green",
    idle: "gray",
    paused: "yellow",
    done: "green",
    error: "red",
};

// Short labels for the fixed-width state column so nothing wraps.
const STATE_LABEL: Record<string, string> = {
    downloading: "down",
    corrupted: "corrupt",
    checking: "verify",
};

const SECTION_COLOR: Record<string, string> = {
    verifying: "blue",
    downloading: "cyan",
    downloadingQueued: "gray",
    downloadingNoPeers: "gray",
    seeding: "green",
    seedingIdle: "gray",
};

// One visible row in the flattened render: either a section heading or a torrent.
type Row =
    | { kind: "title"; section: TorrentSection; shown: number }
    | { kind: "item"; view: TorrentView }
    | { kind: "more"; count: number };

export function TorrentTable(props: {
    sections: TorrentSection[];
    selectedHash?: string;
    width: number;
    height: number;
}) {
    const { sections, selectedHash, width, height } = props;
    const nameWidth = Math.max(10, width - 117);
    const total = sections.reduce((a, s) => a + s.items.length, 0);

    if (total === 0) {
        return <Text dimColor>No torrents. Drop .torrent files into a watched folder, or paste a folder path below.</Text>;
    }

    // 1 line for the column header; the rest is split evenly across the four
    // sections so the content above the list always stays on screen.
    const bodyLines = Math.max(sections.length, height - 1);
    const base = Math.floor(bodyLines / sections.length);
    const extra = bodyLines % sections.length;

    const rows: Row[] = [];
    sections.forEach((section, i) => {
        let sectionLines = base;
        if (i < extra) sectionLines += 1;
        if (sectionLines < 1) return;
        const itemLines = sectionLines - 1; // one line for the title
        const window = pickWindow(section.items, itemLines, selectedHash);
        rows.push({ kind: "title", section, shown: window.items.length });
        for (const v of window.items) rows.push({ kind: "item", view: v });
        if (window.hiddenAfter > 0) rows.push({ kind: "more", count: window.hiddenAfter });
    });

    return (
        <Box flexDirection="column" width={width}>
            <Box>
                <Box width={2}><Text> </Text></Box>
                <Box width={nameWidth}><Text dimColor bold>name</Text></Box>
                <Box width={8}><Text dimColor bold>state</Text></Box>
                <Box width={7}><Text dimColor bold>prog</Text></Box>
                <Box width={9}><Text dimColor bold>size</Text></Box>
                <Box width={7}><Text dimColor bold>chunks</Text></Box>
                <Box width={9}><Text dimColor bold>↓ rate</Text></Box>
                <Box width={9}><Text dimColor bold>↑ rate</Text></Box>
                <Box width={15}><Text dimColor bold>conn/seed/all</Text></Box>
                <Box width={7}><Text dimColor bold>dn/up</Text></Box>
                <Box width={8}><Text dimColor bold>eta</Text></Box>
                <Box width={6}><Text dimColor bold>ratio</Text></Box>
                <Box width={12}><Text dimColor bold>started</Text></Box>
                <Box width={12}><Text dimColor bold>finished</Text></Box>
                <Text dimColor bold>trk</Text>
            </Box>
            {rows.map((row, idx) => {
                if (row.kind === "title") {
                    return (
                        <Box key={`t-${row.section.key}`}>
                            <Text bold color={SECTION_COLOR[row.section.key] || "white"}>
                                {row.section.title}
                            </Text>
                            <Text dimColor>{`  (${row.section.items.length})`}</Text>
                        </Box>
                    );
                }
                if (row.kind === "more") {
                    return (
                        <Box key={`m-${idx}`}>
                            <Box width={2}><Text> </Text></Box>
                            <Text dimColor>{`… +${row.count} more`}</Text>
                        </Box>
                    );
                }
                const v = row.view;
                const selected = v.infoHash === selectedHash;
                return (
                    <Box key={v.infoHash}>
                        <Box width={2}><Text color="cyan">{selected && "›" || " "}</Text></Box>
                        <Box width={nameWidth}>
                            <Text bold={selected} inverse={selected}>{truncate(v.name, nameWidth - 1)}</Text>
                        </Box>
                        <Box width={8}><Text color={STATE_COLOR[v.state] || "white"}>{STATE_LABEL[v.state] || v.state}</Text></Box>
                        <Box width={7}><Text>{formatPercent(v.progress)}</Text></Box>
                        <Box width={9}><Text>{formatBytes(v.sizeBytes)}</Text></Box>
                        <Box width={7}><Text>{String(v.pieceCount)}</Text></Box>
                        <Box width={9}><Text color="cyan">{formatRate(v.downRate)}</Text></Box>
                        <Box width={9}><Text color="green">{formatRate(v.upRate)}</Text></Box>
                        <Box width={15}><Text>{`${v.connectedPeers}/${formatNumber(v.seeders)}/${formatNumber(v.swarmPeers)}`}</Text></Box>
                        <Box width={7}><Text>{`${v.peersUnchokingUs}↓/${v.peersWeUnchoked}↑`}</Text></Box>
                        <Box width={8}><Text>{v.progress >= 1 && "—" || formatEta(v.etaSeconds)}</Text></Box>
                        <Box width={6}><Text>{v.ratio.toFixed(2)}</Text></Box>
                        <Box width={12}><Text dimColor>{formatDateTime(v.startedAtMs)}</Text></Box>
                        <Box width={12}><Text dimColor>{formatDateTime(v.finishedAtMs)}</Text></Box>
                        <Text>{`${v.trackersResponding}/${v.trackersTotal}`}</Text>
                    </Box>
                );
            })}
        </Box>
    );
}

// Choose which slice of a section's items to render. Reserves the last line for
// a "+N more" marker when items overflow, and scrolls to keep the selected
// torrent visible if it lives in this section.
function pickWindow(
    items: TorrentView[],
    itemLines: number,
    selectedHash?: string,
): { items: TorrentView[]; hiddenAfter: number } {
    if (itemLines <= 0) return { items: [], hiddenAfter: items.length };
    if (items.length <= itemLines) return { items, hiddenAfter: 0 };

    const visible = itemLines - 1; // last line is the "+N more" marker
    let start = 0;
    const selIdx = items.findIndex((v) => v.infoHash === selectedHash);
    if (selIdx >= 0) {
        if (selIdx >= visible) start = selIdx - visible + 1;
        if (start > items.length - visible) start = items.length - visible;
    }
    return { items: items.slice(start, start + visible), hiddenAfter: items.length - visible };
}
