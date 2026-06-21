import React from "react";
import { Box, Text } from "ink";
import { AggregateView } from "../torrentManager";
import { RunMode, MODE_LABEL, MODE_DESC } from "../config";
import { formatBytes, formatRate, formatNumber } from "./format";

export function Header(props: { agg: AggregateView; localIP: string; width: number; mode: RunMode }) {
    const { agg, localIP, width, mode } = props;
    const full = mode === "full";
    return (
        <Box flexDirection="column" width={width} borderStyle="round" borderColor={full ? "cyan" : "yellow"} paddingX={1}>
            <Box>
                <Text bold color="cyan">bittorrent</Text>
                <Text dimColor> · via WireGuard </Text>
                <Text color="green">{localIP}</Text>
            </Box>
            <Box>
                <Text backgroundColor={full ? "green" : "yellow"} color="black" bold>{` MODE: ${MODE_LABEL[mode]} `}</Text>
                <Text color={full ? "green" : "yellow"}>{` ${full ? "" : "⚠ "}${MODE_DESC[mode]} · Tab to change`}</Text>
            </Box>
            <Box>
                <Text>{`torrents ${agg.torrents}  `}</Text>
                <Text color="cyan">{`↓dl ${agg.downloading} `}</Text>
                <Text color="green">{`↑seed ${agg.seeding} `}</Text>
                <Text color="yellow">{`⏸ ${agg.paused}  `}</Text>
                <Text dimColor>{`conns ${agg.connections}`}</Text>
            </Box>
            <Box>
                <Text color="cyan">{`↓ ${formatRate(agg.downRate)}  `}</Text>
                <Text color="green">{`↑ ${formatRate(agg.upRate)}   `}</Text>
                <Text dimColor>{`total ↓${formatBytes(agg.downloadedBytes)} ↑${formatBytes(agg.uploadedBytes)}`}</Text>
            </Box>
            <Box>
                <Text dimColor>tunnel </Text>
                <Text color="cyan">{`↓ ${formatRate(agg.wireRecvRate)}  `}</Text>
                <Text color="green">{`↑ ${formatRate(agg.wireSendRate)}   `}</Text>
                <Text dimColor>{`total ↓${formatBytes(agg.wireBytesReceived)} ↑${formatBytes(agg.wireBytesSent)} · pkts ↓${formatNumber(agg.wirePacketsReceived)} ↑${formatNumber(agg.wirePacketsSent)}`}</Text>
            </Box>
        </Box>
    );
}
