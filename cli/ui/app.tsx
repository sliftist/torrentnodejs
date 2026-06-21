import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { statSync } from "fs";
import { TorrentManager } from "../torrentManager";
import { SourceWatcher } from "../watcher";
import { normalizeForFilter, truncate } from "./format";
import { cleanPathInput, RUN_MODES, RunMode } from "../config";
import { Header } from "./header";
import { TorrentTable } from "./torrentTable";
import { DetailView, DETAIL_TABS, DetailTab } from "./detailView";

export interface AppProps {
    manager: TorrentManager;
    watcher: SourceWatcher;
    localIP: string;
    // Persist a newly-added source folder to config + start watching it.
    onAddSource: (folder: string) => void;
}

type Mode = "list" | "detail";

// Cap UI redraws to ~14 fps. Coalesces bursts of manager "update" events into a
// single render so input stays responsive during mass torrent state changes.
const RENDER_THROTTLE_MS = 70;

export function App(props: AppProps) {
    const { manager, watcher, localIP, onAddSource } = props;
    const { exit } = useApp();
    const { stdout } = useStdout();

    const [, setTick] = useState(0);
    const [dims, setDims] = useState({ cols: stdout?.columns || 80, rows: stdout?.rows || 24 });
    const [mode, setMode] = useState<Mode>("list");
    const [filter, setFilter] = useState("");
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectedHash, setSelectedHash] = useState<string | undefined>(undefined);
    const [tab, setTab] = useState<DetailTab>("general");
    const [scroll, setScroll] = useState(0);
    const [notice, setNotice] = useState<string>("");

    useEffect(() => {
        // The manager fires "update" once per torrent state change, so a batch
        // operation (e.g. switching modes restarts every torrent) emits a burst
        // — hundreds at once with thousands of torrents. Re-rendering the whole
        // TUI synchronously on each one starves the event loop and freezes input.
        // Coalesce the burst into at most one render per frame; a trailing timer
        // guarantees the final state is drawn once the burst settles.
        let scheduled: NodeJS.Timeout | undefined;
        const onUpdate = () => {
            if (scheduled) return;
            scheduled = setTimeout(() => {
                scheduled = undefined;
                setTick((t) => t + 1);
            }, RENDER_THROTTLE_MS);
            scheduled.unref?.();
        };
        const onNotice = (msg: string) => setNotice(msg);
        manager.on("update", onUpdate);
        manager.on("notice", onNotice);
        return () => {
            if (scheduled) clearTimeout(scheduled);
            manager.off("update", onUpdate);
            manager.off("notice", onNotice);
        };
    }, [manager]);

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => setDims({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
        stdout.on("resize", onResize);
        return () => { stdout.off("resize", onResize); };
    }, [stdout]);

    const allViews = manager.views();
    const norm = normalizeForFilter(filter);
    const allSections = manager.sections();
    const sections = allSections.map((s) => ({
        ...s,
        items: norm ? s.items.filter((v) => normalizeForFilter(v.name).includes(norm)) : s.items,
    }));
    // Flatten in section order for keyboard navigation.
    const views = sections.flatMap((s) => s.items);

    // Clamp selection to the filtered list.
    const clampedIndex = Math.min(selectedIndex, Math.max(0, views.length - 1));
    if (clampedIndex !== selectedIndex) setSelectedIndex(clampedIndex);
    const selected = views[clampedIndex];

    useInput((input, key) => {
        if (key.ctrl && input === "c") { exit(); return; }

        if (mode === "detail") {
            if (key.escape) { setMode("list"); setScroll(0); return; }
            if (key.tab || key.rightArrow) { setTab(nextTab(tab, 1)); setScroll(0); return; }
            if (key.leftArrow) { setTab(nextTab(tab, -1)); setScroll(0); return; }
            if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
            if (key.downArrow) { setScroll((s) => s + 1); return; }
            if (input === "p" && selectedHash) { void manager.togglePause(selectedHash); return; }
            if (input === "q") { setMode("list"); setScroll(0); return; }
            return;
        }

        // list mode
        if (key.tab) { manager.setMode(nextRunMode(manager.runMode)); return; }
        if (key.upArrow) { setSelectedIndex((i) => Math.max(0, i - 1)); return; }
        if (key.downArrow) { setSelectedIndex((i) => Math.min(views.length - 1, i + 1)); return; }
        if (key.escape) { setFilter(""); return; }
        if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
        if (key.return) {
            const candidate = cleanPathInput(filter);
            if (candidate && isDirectory(candidate)) {
                onAddSource(candidate);
                setNotice(`Watching ${candidate}`);
                setFilter("");
                return;
            }
            if (selected) {
                setSelectedHash(selected.infoHash);
                setMode("detail");
                setTab("general");
                setScroll(0);
            }
            return;
        }
        // Printable input (includes pasted text) extends the filter / path.
        if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
    });

    const width = dims.cols;
    const detail = mode === "detail" && selectedHash ? manager.detail(selectedHash) : undefined;
    const detailViewModel = mode === "detail" && selectedHash ? views.find((v) => v.infoHash === selectedHash) ?? allViews.find((v) => v.infoHash === selectedHash) : undefined;
    const bodyHeight = Math.max(4, dims.rows - 9);

    return (
        <Box flexDirection="column" width={width}>
            <Header agg={manager.aggregate()} localIP={localIP} width={width} mode={manager.runMode} />
            <Box flexDirection="column" flexGrow={1} marginTop={1}>
                {mode === "detail" && detail && detailViewModel ? (
                    <DetailView view={detailViewModel} detail={detail} tab={tab} scroll={scroll} width={width} height={bodyHeight} />
                ) : (
                    <TorrentTable sections={sections} selectedHash={selected?.infoHash} width={width} height={bodyHeight} />
                )}
            </Box>
            <Footer
                width={width}
                mode={mode}
                filter={filter}
                folders={watcher.watchedFolders}
                notice={notice}
            />
        </Box>
    );
}

function Footer(props: { width: number; mode: Mode; filter: string; folders: string[]; notice: string }) {
    const { width, mode, filter, folders, notice } = props;
    return (
        <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
            <Box>
                <Text dimColor>sources: </Text>
                <Text>{folders.length ? truncate(folders.join("  "), width - 12) : "(none — paste a folder path)"}</Text>
            </Box>
            {mode === "list" ? (
                <Box>
                    <Text color="cyan">filter/path › </Text>
                    <Text>{filter}</Text>
                    <Text inverse> </Text>
                </Box>
            ) : (
                <Box><Text dimColor>Tab/←→ switch view · ↑↓ scroll · p pause · Esc back · Ctrl+C quit</Text></Box>
            )}
            <Box>
                <Text dimColor>
                    {mode === "list"
                        ? "type to filter · paste a folder path + Enter to watch · ↑↓ select · Enter open · Tab cycle mode · Ctrl+C quit"
                        : ""}
                </Text>
                {notice ? <Text color="yellow">  {truncate(notice, width - 4)}</Text> : null}
            </Box>
        </Box>
    );
}

function nextRunMode(current: RunMode): RunMode {
    const i = RUN_MODES.indexOf(current);
    return RUN_MODES[(i + 1) % RUN_MODES.length];
}

function nextTab(current: DetailTab, dir: 1 | -1): DetailTab {
    const i = DETAIL_TABS.indexOf(current);
    const n = (i + dir + DETAIL_TABS.length) % DETAIL_TABS.length;
    return DETAIL_TABS[n];
}

function isDirectory(p: string): boolean {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
}
