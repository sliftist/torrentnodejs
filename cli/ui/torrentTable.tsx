import React from "react";
import { Box, Text } from "ink";
import { TorrentView } from "../torrentManager";
import { formatBytes, formatRate, formatPercent, progressBar, truncate } from "./format";

const STATE_COLOR: Record<string, string> = {
    queued: "gray",
    checking: "blue",
    checked: "blue",
    ready: "magenta",
    downloading: "cyan",
    seeding: "green",
    paused: "yellow",
    done: "green",
    error: "red",
};

export function TorrentTable(props: {
    views: TorrentView[];
    selectedIndex: number;
    width: number;
    height: number;
}) {
    const { views, selectedIndex, width, height } = props;
    const rows = Math.max(1, height);

    // Keep the selected row visible within the window.
    let start = 0;
    if (selectedIndex >= rows) start = selectedIndex - rows + 1;
    const slice = views.slice(start, start + rows);

    const nameWidth = Math.max(10, width - 54);

    if (views.length === 0) {
        return <Text dimColor>No torrents. Drop .torrent files into a watched folder, or paste a folder path below.</Text>;
    }

    return (
        <Box flexDirection="column" width={width}>
            <Box>
                <Box width={2}><Text> </Text></Box>
                <Box width={nameWidth}><Text dimColor bold>name</Text></Box>
                <Box width={11}><Text dimColor bold>state</Text></Box>
                <Box width={8}><Text dimColor bold>prog</Text></Box>
                <Box width={11}><Text dimColor bold>↓ rate</Text></Box>
                <Box width={11}><Text dimColor bold>↑ rate</Text></Box>
                <Text dimColor bold>peers</Text>
            </Box>
            {slice.map((v, i) => {
                const idx = start + i;
                const selected = idx === selectedIndex;
                return (
                    <Box key={v.infoHash}>
                        <Box width={2}><Text color="cyan">{selected ? "›" : " "}</Text></Box>
                        <Box width={nameWidth}>
                            <Text bold={selected} inverse={selected}>{truncate(v.name, nameWidth - 1)}</Text>
                        </Box>
                        <Box width={11}><Text color={STATE_COLOR[v.state] || "white"}>{v.state}</Text></Box>
                        <Box width={8}><Text>{formatPercent(v.progress)}</Text></Box>
                        <Box width={11}><Text color="cyan">{formatRate(v.downRate)}</Text></Box>
                        <Box width={11}><Text color="green">{formatRate(v.upRate)}</Text></Box>
                        <Text>{v.peerCount}</Text>
                    </Box>
                );
            })}
            <Box marginTop={1}>
                <Text dimColor>{`${views.length} torrent(s) · ${formatBytes(views.reduce((a, v) => a + v.sizeBytes, 0))} total`}</Text>
            </Box>
        </Box>
    );
}
