import { useEffect, useRef, useCallback } from "react";
import { scaleLinear } from "d3-scale";
import type { ActogramRow } from "../../models/actogramData";
import { type CircadianDay } from "../../models/circadian";
import type { SleepLevelEntry } from "../../api/types";
import type { ScheduleEntry } from "../../AppContextDef";

export type ColorMode = "stages" | "quality";

export interface ActogramConfig {
    doublePlot: boolean;
    rowHeight: number;
    colorMode: ColorMode;
    tauHours: number;
    leftMargin: number;
    topMargin: number;
    rightMargin: number;
    bottomMargin: number;
    showSchedule?: boolean;
    scheduleEntries?: ScheduleEntry[];
}

const DEFAULT_CONFIG: ActogramConfig = {
    doublePlot: false,
    rowHeight: 5,
    colorMode: "stages",
    tauHours: 24,
    leftMargin: 80,
    topMargin: 30,
    rightMargin: 16,
    bottomMargin: 20,
};

const COLORS = {
    // v1.2 stage colors
    deep: "#1e40af",
    light: "#60a5fa",
    rem: "#06b6d4",
    wake: "#ef4444",
    // UI colors
    background: "#1e293b",
    grid: "#334155",
    text: "#94a3b8",
};

/** Map v1.2 stage level to color */
function stageColor(level: string): string {
    switch (level) {
        case "deep":
            return COLORS.deep;
        case "light":
            return COLORS.light;
        case "rem":
            return COLORS.rem;
        case "wake":
            return COLORS.wake;
        default:
            return COLORS.light;
    }
}

/** Map quality score (0–1) to a red→yellow→green gradient color */
function qualityColor(score: number): string {
    //using range from 50 to 100
    const scaled = Math.max(0, score - 0.5) * 2;
    const s = Math.max(0, Math.min(1, scaled));
    // 0 → red (0°), 0.5 → yellow (60°), 1.0 → green (120°)
    const hue = s * 120;
    return `hsl(${hue}, 75%, 45%)`;
}

/** Format fractional hour (e.g. 23.5) as "23:30" */
function formatHour(h: number): string {
    const hr = Math.floor(((h % 24) + 24) % 24);
    const min = Math.round((h - Math.floor(h)) * 60);
    return String(hr).padStart(2, "0") + ":" + String(min).padStart(2, "0");
}

export function useActogramRenderer(
    rows: ActogramRow[],
    circadian: CircadianDay[],
    config: Partial<ActogramConfig> = {}
) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const tauMode = cfg.tauHours !== 24;
    const baseHours = tauMode ? cfg.tauHours : 24;
    const hoursPerRow = cfg.doublePlot ? baseHours * 2 : baseHours;
    // Wider left margin for tau mode labels ("YYYY-MM-DD HH:mm")
    if (tauMode && cfg.leftMargin === DEFAULT_CONFIG.leftMargin) {
        cfg.leftMargin = 110;
    }

    const getTooltipInfo = useCallback(
        (canvasX: number, canvasY: number): Record<string, string> | null => {
            const dpr = window.devicePixelRatio || 1;
            const x = canvasX * dpr;
            const y = canvasY * dpr;

            const plotWidth = (canvasRef.current?.width ?? 0) / 1 - cfg.leftMargin * dpr - cfg.rightMargin * dpr;
            const rowIdx = Math.floor((y - cfg.topMargin * dpr) / (cfg.rowHeight * dpr));

            if (rowIdx < 0 || rowIdx >= rows.length) return null;
            const row = rows[rowIdx]!;

            const xScale = scaleLinear()
                .domain([0, hoursPerRow])
                .range([cfg.leftMargin * dpr, cfg.leftMargin * dpr + plotWidth]);
            const hour = xScale.invert(x);

            // Find block at this hour
            // In double-plot mode, the right half shows the next day's data (rows are newest-first, so next day is rowIdx-1)
            const blocksToCheck: { block: (typeof row.blocks)[0]; offset: number; sourceRow: typeof row }[] = [];
            for (const block of row.blocks) {
                blocksToCheck.push({ block, offset: 0, sourceRow: row });
            }
            if (cfg.doublePlot && rowIdx > 0) {
                const nextDayRow = rows[rowIdx - 1]!;
                for (const block of nextDayRow.blocks) {
                    blocksToCheck.push({ block, offset: baseHours, sourceRow: nextDayRow });
                }
            }

            for (const { block, offset, sourceRow } of blocksToCheck) {
                if (hour >= block.startHour + offset && hour <= block.endHour + offset) {
                    const info: Record<string, string> = {
                        date: sourceRow.date,
                        start: block.record.startTime.toLocaleTimeString(),
                        end: block.record.endTime.toLocaleTimeString(),
                        duration: block.record.durationHours.toFixed(1) + "h",
                        efficiency: block.record.efficiency + "%",
                    };
                    if (block.record.stages) {
                        const s = block.record.stages;
                        info.stages = `D:${s.deep} L:${s.light} R:${s.rem} W:${s.wake}min`;
                    }
                    info.quality = (block.record.sleepScore * 100).toFixed(0) + "%";
                    return info;
                }
            }
            // Check if hovering over circadian overlay
            const circadianMap = new Map<string, CircadianDay>();
            for (const cd of circadian) circadianMap.set(cd.date, cd);
            // In tau mode, row.date may include time — extract just the date part for lookup
            const rowDateKey = row.date.slice(0, 10);
            const cd = circadianMap.get(rowDateKey);
            if (cd && !cd.isGap) {
                if (tauMode && row.startMs != null) {
                    // In tau mode, compute overlay position relative to row start
                    const nightStartAbsH = ((cd.nightStartHour % 24) + 24) % 24;
                    const nightEndAbsH = ((cd.nightEndHour % 24) + 24) % 24;
                    const rowStartAbsH = (row.startMs % 86_400_000) / 3_600_000;
                    let ns = nightStartAbsH - rowStartAbsH;
                    let ne = nightEndAbsH - rowStartAbsH;
                    // Wrap into [0, baseHours) approximately
                    while (ns < -baseHours / 2) ns += 24;
                    while (ns > baseHours + 12) ns -= 24;
                    while (ne < ns) ne += 24;
                    const h = hour % baseHours;
                    const inOverlay = h >= ns && h <= ne;
                    if (inOverlay) {
                        return {
                            date: row.date,
                            "circadian night": formatHour(nightStartAbsH) + " – " + formatHour(nightEndAbsH),
                            "local τ": cd.localTau.toFixed(2) + "h",
                            confidence: cd.confidence,
                            ...(cd.isForecast ? { type: "predicted" } : {}),
                        };
                    }
                } else {
                    let nightStart = ((cd.nightStartHour % 24) + 24) % 24;
                    let nightEnd = ((cd.nightEndHour % 24) + 24) % 24;
                    const h = ((hour % 24) + 24) % 24;
                    const inOverlay =
                        nightEnd < nightStart ? h >= nightStart || h <= nightEnd : h >= nightStart && h <= nightEnd;
                    if (inOverlay) {
                        return {
                            date: row.date,
                            "circadian night": formatHour(nightStart) + " – " + formatHour(nightEnd),
                            "local τ": cd.localTau.toFixed(2) + "h",
                            confidence: cd.confidence,
                            ...(cd.isForecast ? { type: "predicted" } : {}),
                        };
                    }
                }
            }

            return { date: row.date } as Record<string, string>;
        },
        [rows, circadian, cfg, hoursPerRow]
    );

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || rows.length === 0) return;

        const dpr = window.devicePixelRatio || 1;
        const cssWidth = canvas.clientWidth;
        const cssHeight = cfg.topMargin + rows.length * cfg.rowHeight + cfg.bottomMargin;

        canvas.style.height = cssHeight + "px";
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        ctx.scale(dpr, dpr);

        const plotLeft = cfg.leftMargin;
        const plotWidth = cssWidth - cfg.leftMargin - cfg.rightMargin;
        const plotTop = cfg.topMargin;

        const xScale = scaleLinear()
            .domain([0, hoursPerRow])
            .range([plotLeft, plotLeft + plotWidth]);

        // Clear
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        // Draw hour grid lines
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        for (let h = 0; h <= hoursPerRow; h += 6) {
            const x = xScale(h);
            ctx.beginPath();
            ctx.moveTo(x, plotTop);
            ctx.lineTo(x, plotTop + rows.length * cfg.rowHeight);
            ctx.stroke();
        }

        // Hour labels
        ctx.fillStyle = COLORS.text;
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        for (let h = 0; h <= hoursPerRow; h += 6) {
            if (tauMode) {
                // Relative offset labels: +0, +6, +12, ...
                ctx.fillText("+" + h, xScale(h), plotTop - 8);
            } else {
                const label = h % 24;
                ctx.fillText(label.toString().padStart(2, "0"), xScale(h), plotTop - 8);
            }
        }

        // Draw circadian overlay
        // In double-plot mode, right half shows the next day's overlay (rows are newest-first, so next day is i-1)
        if (circadian.length > 0) {
            const circadianMap = new Map<string, CircadianDay>();
            for (const cd of circadian) {
                circadianMap.set(cd.date, cd);
            }

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i]!;
                // In tau mode, row.date may include time — extract just the date part
                const rowDateKey = row.date.slice(0, 10);
                const cd = circadianMap.get(rowDateKey);
                if (!cd || cd.isGap) continue;

                const y = plotTop + i * cfg.rowHeight;

                // Alpha based on confidence score
                const alpha =
                    "confidenceScore" in cd ? 0.1 + (cd as { confidenceScore: number }).confidenceScore * 0.25 : 0.25;
                ctx.fillStyle = cd.isForecast ? `rgba(251, 191, 36, ${alpha})` : `rgba(168, 85, 247, ${alpha})`;

                if (tauMode && row.startMs != null) {
                    // Tau mode: position night hours relative to row's start time
                    const nightStartAbsH = ((cd.nightStartHour % 24) + 24) % 24;
                    const nightEndAbsH = ((cd.nightEndHour % 24) + 24) % 24;
                    const rowStartAbsH = (row.startMs % 86_400_000) / 3_600_000;
                    const nightDur = (((nightEndAbsH - nightStartAbsH) % 24) + 24) % 24;

                    let ns = nightStartAbsH - rowStartAbsH;
                    while (ns < -12) ns += 24;
                    while (ns > baseHours + 12) ns -= 24;
                    const ne = ns + nightDur;

                    // Clip to row bounds [0, baseHours]
                    const drawOverlaySegment = (start: number, end: number, offset: number) => {
                        const s = Math.max(0, start) + offset;
                        const e = Math.min(baseHours, end) + offset;
                        if (e > s) {
                            ctx.fillRect(xScale(s), y, xScale(e) - xScale(s), cfg.rowHeight);
                        }
                    };

                    drawOverlaySegment(ns, ne, 0);
                    // If night wraps before row start, it might appear at end of row
                    if (ns < 0) drawOverlaySegment(ns + 24, ne + 24, 0);

                    if (cfg.doublePlot) {
                        drawOverlaySegment(ns, ne, baseHours);
                        if (ns < 0) drawOverlaySegment(ns + 24, ne + 24, baseHours);
                    }
                } else {
                    // Calendar mode: normalize night hours to [0, 24) range
                    // Circadian overlay duplicates same day's prediction on both halves,
                    // matching the tooltip's hour % 24 hit-testing logic
                    let nightStart = ((cd.nightStartHour % 24) + 24) % 24;
                    let nightEnd = ((cd.nightEndHour % 24) + 24) % 24;

                    if (nightEnd < nightStart) {
                        ctx.fillRect(xScale(nightStart), y, xScale(24) - xScale(nightStart), cfg.rowHeight);
                        ctx.fillRect(xScale(0), y, xScale(nightEnd) - xScale(0), cfg.rowHeight);
                    } else {
                        ctx.fillRect(xScale(nightStart), y, xScale(nightEnd) - xScale(nightStart), cfg.rowHeight);
                    }

                    if (cfg.doublePlot) {
                        nightStart += 24;
                        nightEnd += 24;
                        if (nightEnd < nightStart) {
                            ctx.fillRect(xScale(nightStart), y, xScale(48) - xScale(nightStart), cfg.rowHeight);
                            ctx.fillRect(xScale(24), y, xScale(nightEnd) - xScale(24), cfg.rowHeight);
                        } else {
                            ctx.fillRect(xScale(nightStart), y, xScale(nightEnd) - xScale(nightStart), cfg.rowHeight);
                        }
                    }
                }
            }
        }

        // Draw schedule overlay
        // In double-plot mode, right half shows the next day's schedule (rows are newest-first, so next day is i-1)
        if (cfg.showSchedule && cfg.scheduleEntries && cfg.scheduleEntries.length > 0) {
            ctx.fillStyle = "rgba(34, 197, 94, 0.2)"; // green with alpha

            const drawScheduleForRow = (sourceRow: ActogramRow, y: number, offset: number) => {
                if (tauMode && sourceRow.startMs != null) {
                    const rowStartMs = sourceRow.startMs;
                    const rowEndMs = rowStartMs + baseHours * 3_600_000;

                    const startDate = new Date(rowStartMs);
                    const endDate = new Date(rowEndMs);
                    const d = new Date(startDate);
                    d.setHours(0, 0, 0, 0);

                    while (d.getTime() <= endDate.getTime()) {
                        const dayMs = d.getTime();
                        const jsDay = d.getDay();
                        const dayIndex = jsDay === 0 ? 6 : jsDay - 1;

                        for (const entry of cfg.scheduleEntries!) {
                            if (!entry.days[dayIndex]) continue;

                            const startParts = entry.startTime.split(":");
                            const endParts = entry.endTime.split(":");
                            const sH = parseInt(startParts[0] ?? "0", 10) + parseInt(startParts[1] ?? "0", 10) / 60;
                            const eH = parseInt(endParts[0] ?? "0", 10) + parseInt(endParts[1] ?? "0", 10) / 60;

                            const drawAbsBlock = (absStart: number, absEnd: number) => {
                                const iStart = Math.max(absStart, rowStartMs);
                                const iEnd = Math.min(absEnd, rowEndMs);

                                if (iEnd > iStart) {
                                    const xStart = (iStart - rowStartMs) / 3_600_000 + offset;
                                    const xEnd = (iEnd - rowStartMs) / 3_600_000 + offset;
                                    ctx.fillRect(xScale(xStart), y, xScale(xEnd) - xScale(xStart), cfg.rowHeight);
                                }
                            };

                            if (eH <= sH) {
                                const startMs = dayMs + sH * 3_600_000;
                                const endMs = dayMs + 24 * 3_600_000 + eH * 3_600_000;
                                drawAbsBlock(startMs, dayMs + 24 * 3_600_000);
                                drawAbsBlock(dayMs + 24 * 3_600_000, endMs);
                            } else {
                                const startMs = dayMs + sH * 3_600_000;
                                const endMs = dayMs + eH * 3_600_000;
                                drawAbsBlock(startMs, endMs);
                            }
                        }

                        d.setDate(d.getDate() + 1);
                    }
                } else {
                    const dateStr = sourceRow.date.slice(0, 10);
                    const dateObj = new Date(dateStr + "T12:00:00");
                    const jsDay = dateObj.getDay();
                    const dayIndex = jsDay === 0 ? 6 : jsDay - 1;

                    for (const entry of cfg.scheduleEntries!) {
                        if (!entry.days[dayIndex]) continue;

                        const startParts = entry.startTime.split(":");
                        const endParts = entry.endTime.split(":");
                        const startHour = parseInt(startParts[0] ?? "0", 10) + parseInt(startParts[1] ?? "0", 10) / 60;
                        const endHour = parseInt(endParts[0] ?? "0", 10) + parseInt(endParts[1] ?? "0", 10) / 60;

                        const drawSegment = (s: number, e: number, o: number) => {
                            const start = Math.max(0, s) + o;
                            const end = Math.min(24, e) + o;
                            if (end > start) {
                                ctx.fillRect(xScale(start), y, xScale(end) - xScale(start), cfg.rowHeight);
                            }
                        };

                        if (endHour <= startHour) {
                            drawSegment(startHour, 24, offset);
                            drawSegment(0, endHour, offset);
                        } else {
                            drawSegment(startHour, endHour, offset);
                        }
                    }
                }
            };

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i]!;
                const y = plotTop + i * cfg.rowHeight;

                // Left side: this row's schedule
                drawScheduleForRow(row, y, 0);

                // Right side: next day's schedule (rows are newest-first, so next day is i-1)
                if (cfg.doublePlot && i > 0) {
                    drawScheduleForRow(rows[i - 1]!, y, baseHours);
                }
            }
        }

        // Draw sleep blocks
        // In double-plot mode, the right half of row i shows the NEXT day's data.
        // Rows are newest-first, so the next day for row i is row i-1.
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i]!;
            const y = plotTop + i * cfg.rowHeight;

            // Helper to draw a block at a given hour offset on this row's y position
            const drawBlockAt = (block: (typeof row.blocks)[0], hourOffset: number, sourceRow: ActogramRow) => {
                const bStart = block.startHour + hourOffset;
                const bEnd = block.endHour + hourOffset;
                const blockPixelWidth = xScale(bEnd) - xScale(bStart);

                if (cfg.colorMode === "quality") {
                    ctx.fillStyle = qualityColor(block.record.sleepScore);
                    ctx.fillRect(xScale(bStart), y, Math.max(blockPixelWidth, 1), cfg.rowHeight - 0.5);
                } else if (block.record.stageData && blockPixelWidth > 5) {
                    drawStageBlock(
                        ctx,
                        xScale,
                        block.record.stageData,
                        block.record.startTime,
                        sourceRow.date,
                        bStart,
                        bEnd,
                        y,
                        cfg.rowHeight,
                        hourOffset,
                        sourceRow.startMs
                    );
                } else {
                    ctx.fillStyle = COLORS.light;
                    ctx.fillRect(xScale(bStart), y, Math.max(blockPixelWidth, 1), cfg.rowHeight - 0.5);
                }
            };

            // Left side: this row's blocks
            for (const block of row.blocks) {
                drawBlockAt(block, 0, row);
            }

            // Right side: next day's blocks (rows are newest-first, so next day is i-1)
            if (cfg.doublePlot && i > 0) {
                const nextDayRow = rows[i - 1]!;
                for (const block of nextDayRow.blocks) {
                    drawBlockAt(block, baseHours, nextDayRow);
                }
            }
        }

        // Date labels
        ctx.fillStyle = COLORS.text;
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "right";
        const labelInterval = cfg.rowHeight < 6 ? 7 : 1;
        for (let i = 0; i < rows.length; i += labelInterval) {
            const row = rows[i]!;
            const y = plotTop + i * cfg.rowHeight + cfg.rowHeight;
            ctx.fillText(row.date, plotLeft - 6, y);
        }
    }, [rows, circadian, cfg, hoursPerRow]);

    return { canvasRef, getTooltipInfo };
}

/**
 * Draw a sleep block colored by v1.2 stage data intervals.
 *
 * blockStartHour/blockEndHour are on the x-axis scale (0..24 or 0..48 for double plot).
 * hourOffset is 0 for the first plot, 24 for the double-plot repeat.
 *
 * Strategy: compute the block's absolute time boundaries, then map each stage entry
 * into the x-axis coordinate space by linear interpolation.
 */
function drawStageBlock(
    ctx: CanvasRenderingContext2D,
    xScale: (h: number) => number,
    stageData: SleepLevelEntry[],
    recordStart: Date,
    _rowDate: string,
    blockStartHour: number,
    blockEndHour: number,
    y: number,
    rowHeight: number,
    hourOffset: number,
    rowStartMs?: number
) {
    if (blockEndHour <= blockStartHour) return;
    const blockDurationHours = blockEndHour - blockStartHour;

    let blockAbsStartMs: number;
    let blockAbsEndMs: number;

    if (rowStartMs != null) {
        // Tau mode: row startMs is known, so absolute position is straightforward
        const localBlockStartH = blockStartHour - hourOffset;
        blockAbsStartMs = rowStartMs + localBlockStartH * 3_600_000;
        blockAbsEndMs = blockAbsStartMs + blockDurationHours * 3_600_000;
    } else {
        // Calendar mode: reconstruct from midnight
        const recordStartMs = recordStart.getTime();
        const recordMidnight = new Date(recordStart);
        recordMidnight.setHours(0, 0, 0, 0);
        const recordMidnightMs = recordMidnight.getTime();

        const localBlockStartH = blockStartHour - hourOffset;
        const recordLocalStartH = (recordStartMs - recordMidnightMs) / 3_600_000;

        let dayMidnightMs: number;
        if (localBlockStartH >= recordLocalStartH - 0.5) {
            dayMidnightMs = recordMidnightMs;
        } else {
            dayMidnightMs = recordMidnightMs + 24 * 3_600_000;
        }

        blockAbsStartMs = dayMidnightMs + localBlockStartH * 3_600_000;
        blockAbsEndMs = blockAbsStartMs + blockDurationHours * 3_600_000;
    }

    for (const entry of stageData) {
        const entryStartMs = new Date(entry.dateTime).getTime();
        const entryEndMs = entryStartMs + entry.seconds * 1000;

        // Clip to block time range
        const visStartMs = Math.max(entryStartMs, blockAbsStartMs);
        const visEndMs = Math.min(entryEndMs, blockAbsEndMs);
        if (visEndMs <= visStartMs) continue;

        // Map to x-axis hours
        const xStart = blockStartHour + (visStartMs - blockAbsStartMs) / 3_600_000;
        const xEnd = blockStartHour + (visEndMs - blockAbsStartMs) / 3_600_000;

        ctx.fillStyle = stageColor(entry.level);
        ctx.fillRect(xScale(xStart), y, Math.max(xScale(xEnd) - xScale(xStart), 0.5), rowHeight - 0.5);
    }
}
