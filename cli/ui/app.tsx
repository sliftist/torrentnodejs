import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { statSync } from "fs";
import { formatTime } from "socket-function/src/formatting/format";
import { sharedWatchdog, WatchdogLine } from "../../watchdog";
import { TorrentManager, TorrentView } from "../torrentManager";
import { SourceWatcher } from "../watcher";
import { normalizeForFilter, truncate } from "./format";
import { cleanPathInput, RUN_MODES, RunMode, SchedulerSettings } from "../config";
import { Header } from "./header";
import { TorrentTable } from "./torrentTable";
import { DetailView, DETAIL_TABS, DetailTab } from "./detailView";

export interface AppProps {
    manager: TorrentManager;
    watcher: SourceWatcher;
    localIP: string;
    // Persist a newly-added source folder to config + start watching it.
    onAddSource: (folder: string) => void;
    // Apply + persist changed transfer limits.
    onSchedulerChange: (changes: Partial<SchedulerSettings>) => void;
    // Connection details for the web-control server, shown via an action.
    webUrl?: string;
    webPassword?: string;
    // Chrome DevTools URL for attaching a debugger to this (main) process.
    debugUrl?: string;
    // DevTools URLs for each verify worker thread, fetched fresh each render so
    // workers that report their inspector late still show up.
    getWorkerDebugUrls?: () => string[];
}

type View = "list" | "detail";
// Transient input surfaces drawn over the footer. "none" is the resting state.
type Overlay = "none" | "actions" | "filter" | "addFolder" | "limits" | "confirmDelete" | "debug" | "watchdog";

interface Action {
    label: string;
    run: () => void;
}

// The editable limits, in display order. Keys map straight onto
// SchedulerSettings; everything here is a plain integer.
const LIMIT_FIELDS: { key: keyof SchedulerSettings; label: string }[] = [
    { key: "downloadMbps", label: "Download (Mbps, 0=∞)" },
    { key: "uploadMbps", label: "Upload (Mbps, 0=∞)" },
    { key: "downloadSlots", label: "Download slots" },
    { key: "activeConnections", label: "Max connections" },
    { key: "connectionsPerTorrent", label: "Conns / torrent" },
    { key: "uploadSlots", label: "Upload slots" },
    { key: "optimisticUnchokeSlots", label: "Optimistic slots" },
    { key: "downloadSkipLimitMs", label: "Skip stalled (ms)" },
    { key: "watchIntervalMs", label: "Rescan folders (ms)" },
    { key: "concurrentScans", label: "Concurrent scans" },
    { key: "verifyScanMbps", label: "Verify scan (MB/s, 0=∞)" },
];

// Cap UI redraws to ~14 fps. Coalesces bursts of manager "update" events into a
// single render so input stays responsive during mass torrent state changes.
const RENDER_THROTTLE_MS = 70;
const MENU_WIDTH = 36;

// Fixed vertical chrome around the scrollable body, so the table is told
// exactly how many lines it may use. Header = 6 content rows + 2 border lines;
// Footer = 4 content rows (hint, sources, output, web) + 2 border lines; plus
// the body's own marginTop. Keep these in sync with the Header/Footer components.
const HEADER_HEIGHT = 8;
const FOOTER_HEIGHT = 6;
const BODY_MARGIN_TOP = 1;
// The collapsed watchdog strip is always on screen: a worker-time summary line
// above the two busiest main-thread lines.
const WATCHDOG_BAR_HEIGHT = 3;
const CHROME_HEIGHT = HEADER_HEIGHT + FOOTER_HEIGHT + BODY_MARGIN_TOP + WATCHDOG_BAR_HEIGHT;

export function App(props: AppProps) {
    const { manager, watcher, localIP, onAddSource, onSchedulerChange, webUrl, webPassword, debugUrl, getWorkerDebugUrls } = props;
    const { exit } = useApp();
    const { stdout } = useStdout();

    const [, setTick] = useState(0);
    const [dims, setDims] = useState({ cols: stdout?.columns || 80, rows: stdout?.rows || 24 });
    const [view, setView] = useState<View>("list");
    const [overlay, setOverlay] = useState<Overlay>("none");
    const [filter, setFilter] = useState("");
    const [folderDraft, setFolderDraft] = useState("");
    // Limits editor: per-field draft strings + which field is focused.
    const [limitsDraft, setLimitsDraft] = useState<Record<string, string>>({});
    const [limitIndex, setLimitIndex] = useState(0);
    const [actionIndex, setActionIndex] = useState(0);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selectedHash, setSelectedHash] = useState<string | undefined>(undefined);
    const [pendingDelete, setPendingDelete] = useState<TorrentView | undefined>(undefined);
    const [tab, setTab] = useState<DetailTab>("general");
    const [scroll, setScroll] = useState(0);
    const [notice, setNotice] = useState<string>("");
    // Path of the most recently generated trackerless .torrent (shown in the footer).
    const [trackerlessPath, setTrackerlessPath] = useState<string>("");

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
        // Keep the watchdog strip current while the swarm is idle (no manager
        // updates would otherwise redraw it).
        const t = setInterval(() => setTick((x) => x + 1), 2000);
        t.unref?.();
        return () => clearInterval(t);
    }, []);

    useEffect(() => {
        if (!stdout) return;
        const onResize = () => setDims({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
        stdout.on("resize", onResize);
        return () => { stdout.off("resize", onResize); };
    }, [stdout]);

    const norm = normalizeForFilter(filter);
    const allSections = manager.sections();
    const sections = allSections.map((s) => ({
        ...s,
        items: norm ? s.items.filter((v) => normalizeForFilter(v.name).includes(norm)) : s.items,
    }));
    // Flatten in section order for keyboard navigation.
    const views = sections.flatMap((s) => s.items);
    // Flat index where each non-empty section begins, for PgUp/PgDn jumps.
    const sectionStarts: number[] = [];
    {
        let acc = 0;
        for (const s of sections) {
            if (s.items.length === 0) continue;
            sectionStarts.push(acc);
            acc += s.items.length;
        }
    }

    // Selection follows the torrent itself (by infoHash), not its row number —
    // the list re-sorts constantly, so an index would point at a different
    // torrent every render. Fall back to the last position only when the
    // selected torrent has vanished (deleted/filtered out).
    const hashIndex = views.findIndex((v) => v.infoHash === selectedHash);
    const clampedIndex = hashIndex >= 0 && hashIndex || Math.min(selectedIndex, Math.max(0, views.length - 1));
    const selected = views[clampedIndex];

    function selectIndex(i: number): void {
        const clamped = Math.min(views.length - 1, Math.max(0, i));
        setSelectedIndex(clamped);
        setSelectedHash(views[clamped]?.infoHash);
    }

    const detail = view === "detail" && selectedHash ? manager.detail(selectedHash) : undefined;
    const detailViewModel = view === "detail" && selectedHash
        ? views.find((v) => v.infoHash === selectedHash) ?? manager.views().find((v) => v.infoHash === selectedHash)
        : undefined;
    // The torrent that context actions (pause, open) apply to.
    const focusTorrent = view === "detail" ? detailViewModel : selected;

    function openDetail(v: TorrentView): void {
        setSelectedHash(v.infoHash);
        setView("detail");
        setTab("general");
        setScroll(0);
        setOverlay("none");
    }

    function openLimits(): void {
        const s = manager.schedulerSettings;
        const draft: Record<string, string> = {};
        for (const f of LIMIT_FIELDS) draft[f.key] = String(s[f.key]);
        setLimitsDraft(draft);
        setLimitIndex(0);
        setOverlay("limits");
    }

    function jumpSection(dir: 1 | -1): void {
        if (sectionStarts.length === 0) return;
        let cur = 0;
        for (let i = 0; i < sectionStarts.length; i++) {
            if (sectionStarts[i] <= clampedIndex) cur = i;
        }
        const next = Math.min(sectionStarts.length - 1, Math.max(0, cur + dir));
        selectIndex(sectionStarts[next]);
    }

    // Built fresh each render so labels (Pause/Resume, current mode) stay live.
    // Future operations (e.g. "Show web password") slot in as new entries here.
    function buildActions(): Action[] {
        const acts: Action[] = [];
        if (focusTorrent) {
            const f = focusTorrent;
            if (view === "list") acts.push({ label: "Open details", run: () => openDetail(f) });
            acts.push({
                label: "Delete (data + .torrent)",
                run: () => { setPendingDelete(f); setOverlay("confirmDelete"); },
            });
            const paused = f.state === "paused";
            acts.push({
                label: paused && "Resume" || "Pause",
                run: () => { setOverlay("none"); void manager.togglePause(f.infoHash); },
            });
            const prioritized = manager.isPrioritized(f.infoHash);
            acts.push({
                label: prioritized && "Unprioritize" || "Prioritize (web)",
                run: () => { setOverlay("none"); manager.setPriority(f.infoHash, !prioritized); },
            });
            acts.push({
                label: "Generate trackerless .torrent",
                run: async () => {
                    setOverlay("none");
                    try {
                        const outPath = await manager.generateTrackerlessTorrent(f.infoHash);
                        setTrackerlessPath(outPath);
                        setNotice(`Trackerless .torrent → ${outPath}`);
                    } catch (e) {
                        setNotice(`Generate failed: ${(e as Error).message}`);
                    }
                },
            });
        }
        acts.push({ label: "Add folder…", run: () => { setFolderDraft(""); setOverlay("addFolder"); } });
        acts.push({ label: "Options…", run: openLimits });
        acts.push({ label: "Debug URLs (per thread)…", run: () => setOverlay("debug") });
        if (webUrl && webPassword) {
            acts.push({
                label: "Show web password",
                run: () => { setOverlay("none"); setNotice(`Web control: ${webUrl}  ·  password: ${webPassword}`); },
            });
        }
        acts.push({
            label: `Switch mode (now: ${manager.runMode})`,
            run: () => { setOverlay("none"); manager.setMode(nextRunMode(manager.runMode)); },
        });
        return acts;
    }
    const actions = buildActions();

    useInput((input, key) => {
        if (key.ctrl && input === "c") { exit(); return; }

        if (overlay === "filter") {
            if (key.escape) { setFilter(""); setOverlay("none"); return; }
            if (key.return) { setOverlay("none"); return; }
            if (key.backspace || key.delete) { setFilter((f) => f.slice(0, -1)); return; }
            if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
            return;
        }

        if (overlay === "addFolder") {
            if (key.escape) { setFolderDraft(""); setOverlay("none"); return; }
            if (key.return) {
                const candidate = cleanPathInput(folderDraft);
                if (candidate && isDirectory(candidate)) {
                    onAddSource(candidate);
                    setNotice(`Watching ${candidate}`);
                    setFolderDraft("");
                    setOverlay("none");
                } else {
                    setNotice(`Not a folder: ${candidate || "(empty)"}`);
                }
                return;
            }
            if (key.backspace || key.delete) { setFolderDraft((f) => f.slice(0, -1)); return; }
            if (input && !key.ctrl && !key.meta) setFolderDraft((f) => f + input);
            return;
        }

        if (overlay === "limits") {
            if (key.escape) { setOverlay("none"); return; }
            if (key.upArrow) { setLimitIndex((i) => Math.max(0, i - 1)); return; }
            if (key.downArrow) { setLimitIndex((i) => Math.min(LIMIT_FIELDS.length - 1, i + 1)); return; }
            if (key.return) {
                const changes: Partial<SchedulerSettings> = {};
                for (const f of LIMIT_FIELDS) {
                    const n = parseInt(limitsDraft[f.key], 10);
                    if (isFinite(n) && n >= 0) changes[f.key] = n;
                }
                onSchedulerChange(changes);
                setNotice("Options updated");
                setOverlay("none");
                return;
            }
            const cur = LIMIT_FIELDS[Math.min(limitIndex, LIMIT_FIELDS.length - 1)].key;
            if (key.backspace || key.delete) {
                setLimitsDraft((d) => ({ ...d, [cur]: (d[cur] || "").slice(0, -1) }));
                return;
            }
            if (input && /^[0-9]$/.test(input)) {
                setLimitsDraft((d) => ({ ...d, [cur]: (d[cur] || "") + input }));
            }
            return;
        }

        if (overlay === "confirmDelete") {
            if (input === "y" && pendingDelete) {
                const target = pendingDelete;
                setPendingDelete(undefined);
                setOverlay("none");
                if (view === "detail") { setView("list"); setScroll(0); }
                void manager.deleteTorrent(target.infoHash);
                return;
            }
            setPendingDelete(undefined);
            setOverlay("none");
            return;
        }

        if (overlay === "actions") {
            if (key.escape || key.leftArrow) { setOverlay("none"); return; }
            if (key.upArrow) { setActionIndex((i) => Math.max(0, i - 1)); return; }
            if (key.downArrow) { setActionIndex((i) => Math.min(actions.length - 1, i + 1)); return; }
            if (key.return) { actions[Math.min(actionIndex, actions.length - 1)]?.run(); return; }
            return;
        }

        if (overlay === "debug") {
            setOverlay("none");
            return;
        }

        if (overlay === "watchdog") {
            setOverlay("none");
            return;
        }

        // Resting state: shared keys first.
        if (input === "a") { setActionIndex(0); setOverlay("actions"); return; }
        if (input === "o") { openLimits(); return; }
        if (input === "w") { setOverlay("watchdog"); return; }
        if (input === "/") { setOverlay("filter"); return; }

        if (view === "detail") {
            if (key.leftArrow || key.escape || input === "q") { setView("list"); setScroll(0); return; }
            if (key.tab && key.shift) { setTab(nextTab(tab, -1)); setScroll(0); return; }
            if (key.tab) { setTab(nextTab(tab, 1)); setScroll(0); return; }
            if (key.upArrow) { setScroll((s) => Math.max(0, s - 1)); return; }
            if (key.downArrow) { setScroll((s) => s + 1); return; }
            if (input === "p" && focusTorrent) { void manager.togglePause(focusTorrent.infoHash); return; }
            return;
        }

        // list view
        if (key.tab) { manager.setMode(nextRunMode(manager.runMode)); return; }
        if (key.upArrow) { selectIndex(clampedIndex - 1); return; }
        if (key.downArrow) { selectIndex(clampedIndex + 1); return; }
        if (key.pageUp) { jumpSection(-1); return; }
        if (key.pageDown) { jumpSection(1); return; }
        if (key.rightArrow || key.return) { if (selected) openDetail(selected); return; }
        if (key.escape && filter) { setFilter(""); return; }
    });

    const width = dims.cols;
    // An open overlay (actions/options/confirm) is a sibling rendered below the
    // body, so its lines have to come OUT of the body's budget — otherwise the
    // column is taller than the terminal and Ink can't erase the previous frame,
    // leaving ghosted text. Measure the overlay and shrink the body to match.
    let overlayHeight = 0;
    let limitsVisible = LIMIT_FIELDS.length;
    // main thread + each worker thread, fetched fresh so late-reporting workers show.
    const debugLines = overlay === "debug"
        ? [`main: ${debugUrl || "(not started)"}`, ...(getWorkerDebugUrls?.() ?? []).map((u, i) => `worker ${i}: ${u}`)]
        : [];
    const workerLines = sharedWatchdog().workerLines();
    const mainLines = sharedWatchdog().mainLines();
    // Expanded watchdog uses ~half the screen; the collapsed 3-line strip already
    // lives in the chrome, so the overlay only needs the extra rows beyond it.
    const watchdogPanelHeight = Math.max(8, Math.floor(dims.rows / 2));
    if (overlay === "actions") overlayHeight = actions.length + 4;
    else if (overlay === "confirmDelete" && pendingDelete) overlayHeight = 6;
    else if (overlay === "debug") overlayHeight = debugLines.length + 4;
    else if (overlay === "watchdog") overlayHeight = Math.max(0, watchdogPanelHeight - WATCHDOG_BAR_HEIGHT);
    else if (overlay === "limits") {
        limitsVisible = Math.max(3, Math.min(LIMIT_FIELDS.length, dims.rows - CHROME_HEIGHT - 7));
        overlayHeight = limitsVisible + 6;
    }
    const bodyHeight = Math.max(1, dims.rows - CHROME_HEIGHT - overlayHeight);
    const agg = manager.aggregate();

    let body: React.ReactNode;
    if (view === "detail" && detail && detailViewModel) {
        body = <DetailView view={detailViewModel} detail={detail} tab={tab} scroll={scroll} width={width} height={bodyHeight} />;
    } else {
        body = <TorrentTable sections={sections} selectedHash={selected?.infoHash} width={width} height={bodyHeight} verifyEtaMs={agg.verifyEtaMs} />;
    }

    return (
        <Box flexDirection="column" width={width} height={dims.rows}>
            <Header agg={agg} localIP={localIP} width={width} mode={manager.runMode} />
            <Box flexDirection="column" flexGrow={1} marginTop={1}>
                {body}
            </Box>
            {overlay === "watchdog"
                && <WatchdogPanel workerLines={workerLines} mainLines={mainLines} width={width} height={watchdogPanelHeight} />
                || <WatchdogBar workerLines={workerLines} mainLines={mainLines} width={width} />}
            {overlay === "actions" && <ActionsMenu actions={actions} index={actionIndex} />}
            {overlay === "debug" && <DebugMenu lines={debugLines} width={width} />}
            {overlay === "limits" && <LimitsEditor draft={limitsDraft} index={limitIndex} maxVisible={limitsVisible} />}
            {overlay === "confirmDelete" && pendingDelete && <ConfirmDelete name={pendingDelete.name} width={width} />}
            <Footer
                width={width}
                view={view}
                overlay={overlay}
                filter={filter}
                folderDraft={folderDraft}
                folders={watcher.watchedFolders}
                output={manager.outputDir}
                notice={notice}
                webUrl={webUrl}
                debugUrl={debugUrl}
                trackerlessPath={trackerlessPath}
            />
        </Box>
    );
}

function ActionsMenu(props: { actions: Action[]; index: number }) {
    const { actions, index } = props;
    return (
        <Box flexDirection="column" width={MENU_WIDTH} borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">Actions</Text>
            {actions.map((a, i) => {
                const active = i === index;
                return (
                    <Text key={a.label} color={active && "black" || "white"} backgroundColor={active && "cyan" || undefined}>
                        {(active && "› " || "  ") + a.label}
                    </Text>
                );
            })}
            <Text dimColor>↑↓ select · Enter run · Esc close</Text>
        </Box>
    );
}

function DebugMenu(props: { lines: string[]; width: number }) {
    const { lines, width } = props;
    const boxWidth = Math.min(width, 120);
    return (
        <Box flexDirection="column" width={boxWidth} borderStyle="round" borderColor="magenta" paddingX={1}>
            <Text bold color="magenta">Debugger URLs (attach Chrome DevTools per thread)</Text>
            {lines.map((line, i) => (
                <Text key={i} color="magenta">{truncate(line, boxWidth - 4)}</Text>
            ))}
            <Text dimColor>any key close</Text>
        </Box>
    );
}

function fmtWatchdog(l: WatchdogLine): string {
    return `${l.name}  ${l.count}×  ${formatTime(l.timeMs)} /60s`;
}

// Always-on 3-line strip: the worker-time summary on top (with the expand hint),
// then the two busiest main-thread work types below it. Press w to expand.
function WatchdogBar(props: { workerLines: WatchdogLine[]; mainLines: WatchdogLine[]; width: number }) {
    const { workerLines, mainLines, width } = props;
    const worker = workerLines.length
        && `workers: ${workerLines.map((l) => `${l.name} ${l.count}× ${formatTime(l.timeMs)}`).join("  ")}`
        || "workers: (idle)";
    const line1 = `${worker}   · w expand`;
    const line2 = mainLines[0] && `  ${fmtWatchdog(mainLines[0])}` || "  main: (idle)";
    const line3 = mainLines[1] && `  ${fmtWatchdog(mainLines[1])}` || " ";
    return (
        <Box flexDirection="column" width={width} paddingX={1}>
            <Text color="cyan">{truncate(line1, width - 4)}</Text>
            <Text dimColor>{truncate(line2, width - 4)}</Text>
            <Text dimColor>{truncate(line3, width - 4)}</Text>
        </Box>
    );
}

// Expanded watchdog: full worker summary then the full main-thread breakdown,
// trimmed to the rows the panel was given.
function WatchdogPanel(props: { workerLines: WatchdogLine[]; mainLines: WatchdogLine[]; width: number; height: number }) {
    const { workerLines, mainLines, width, height } = props;
    const boxWidth = Math.min(width, 120);
    // 2 border + title + "worker" header + "main" header + footer ≈ 6 fixed rows.
    const mainBudget = Math.max(1, height - 6 - workerLines.length);
    return (
        <Box flexDirection="column" width={boxWidth} height={height} borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">Watchdog — work in the last 60s</Text>
            <Text color="cyan">worker threads:</Text>
            {workerLines.length === 0 && <Text dimColor>  (idle)</Text>}
            {workerLines.map((l) => <Text key={l.name}>{truncate(`  ${fmtWatchdog(l)}`, boxWidth - 4)}</Text>)}
            <Text color="cyan">main thread:</Text>
            {mainLines.length === 0 && <Text dimColor>  (no activity)</Text>}
            {mainLines.slice(0, mainBudget).map((l) => <Text key={l.name}>{truncate(`  ${fmtWatchdog(l)}`, boxWidth - 4)}</Text>)}
            <Text dimColor>any key close</Text>
        </Box>
    );
}

function ConfirmDelete(props: { name: string; width: number }) {
    const { name, width } = props;
    return (
        <Box flexDirection="column" width={Math.min(width, 60)} borderStyle="round" borderColor="red" paddingX={1}>
            <Text bold color="red">Delete torrent</Text>
            <Text>{truncate(name, Math.min(width, 60) - 4)}</Text>
            <Text dimColor>Removes downloaded data AND the .torrent file.</Text>
            <Text dimColor>y confirm · any other key cancel</Text>
        </Box>
    );
}

function LimitsEditor(props: { draft: Record<string, string>; index: number; maxVisible: number }) {
    const { draft, index, maxVisible } = props;
    const total = LIMIT_FIELDS.length;
    const visible = Math.min(maxVisible, total);
    const start = Math.max(0, Math.min(index - Math.floor(visible / 2), total - visible));
    const shown = LIMIT_FIELDS.slice(start, start + visible);
    const moreAbove = start > 0;
    const moreBelow = start + visible < total;
    return (
        <Box flexDirection="column" width={MENU_WIDTH} borderStyle="round" borderColor="cyan" paddingX={1}>
            <Text bold color="cyan">Options</Text>
            <Text dimColor>{moreAbove && "  ↑ more" || " "}</Text>
            {shown.map((f, j) => {
                const i = start + j;
                const active = i === index;
                return (
                    <Box key={f.key} justifyContent="space-between">
                        <Text color={active && "cyan" || "white"}>{(active && "› " || "  ") + f.label}</Text>
                        <Text color={active && "black" || "white"} backgroundColor={active && "cyan" || undefined}>
                            {` ${draft[f.key] || "0"} `}
                        </Text>
                    </Box>
                );
            })}
            <Text dimColor>{moreBelow && "  ↓ more" || " "}</Text>
            <Text dimColor>↑↓ field · 0-9 edit · Enter save · Esc cancel</Text>
        </Box>
    );
}

function Footer(props: {
    width: number;
    view: View;
    overlay: Overlay;
    filter: string;
    folderDraft: string;
    folders: string[];
    output: string;
    notice: string;
    webUrl?: string;
    debugUrl?: string;
    trackerlessPath?: string;
}) {
    const { width, view, overlay, filter, folderDraft, folders, output, notice, webUrl, debugUrl, trackerlessPath } = props;

    let topLine: React.ReactNode;
    if (overlay === "filter") {
        topLine = (
            <Box>
                <Text color="cyan">filter › </Text>
                <Text>{filter}</Text>
                <Text inverse> </Text>
                <Text dimColor>  (Enter apply · Esc clear)</Text>
            </Box>
        );
    } else if (overlay === "addFolder") {
        topLine = (
            <Box>
                <Text color="cyan">add folder › </Text>
                <Text>{folderDraft}</Text>
                <Text inverse> </Text>
                <Text dimColor>  (Enter add · Esc cancel)</Text>
            </Box>
        );
    } else {
        topLine = (
            <Box>
                <Text dimColor>{hintFor(view)}</Text>
                {Boolean(filter) && <Text color="yellow">{`   filter: ${truncate(filter, 20)}`}</Text>}
            </Box>
        );
    }

    const sourcesLine = folders.length > 0
        && `sources: ${truncate(folders.join("  "), width - 16)}`
        || "no source folders — press a → Add folder";

    return (
        <Box flexDirection="column" width={width} borderStyle="round" borderColor="gray" paddingX={1}>
            {topLine}
            <Box>
                <Text dimColor>{sourcesLine}</Text>
                {Boolean(notice) && <Text color="yellow">{`   ${truncate(notice, width - 4)}`}</Text>}
            </Box>
            <Box>
                <Text dimColor>{`output: ${truncate(output, width - 12)}`}</Text>
            </Box>
            <Box>
                <Text dimColor>web: </Text>
                <Text color={webUrl && "cyan" || "gray"}>{webUrl && truncate(webUrl, width - 8) || "(not started)"}</Text>
            </Box>
            <Box>
                <Text dimColor>debug: </Text>
                {Boolean(trackerlessPath) && <Text color="green">{truncate(trackerlessPath || "", width - 9)}</Text>
                    || <Text color={debugUrl && "magenta" || "gray"}>{debugUrl && truncate(debugUrl, width - 9) || "(not started)"}</Text>}
            </Box>
        </Box>
    );
}

function hintFor(view: View): string {
    if (view === "detail") return "Tab/⇧Tab tabs · ↑↓ scroll · a actions · o options · w watchdog · ← back · ^C quit";
    return "↑↓ select · →/Enter open · / filter · a actions · o options · w watchdog · Tab mode · ^C quit";
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
