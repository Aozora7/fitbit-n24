import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { scaleLinear, scaleTime } from "d3-scale";
import { useAppContext } from "../useAppContext";
import { usePersistedState } from "../usePersistedState";
import type { CircadianDay } from "../models/circadian/types";
import type { SleepRecord } from "../api/types";

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 250;

/** Threshold (hours) above which Y-axis switches from clock times to day labels */
const DAY_MODE_THRESHOLD = 72;

/** Hide sleep dots entirely when dataset exceeds this many days */
const DOT_HIDE_THRESHOLD = 1095; // ~3 years

const COLORS = {
    background: "#1e293b",
    grid: "#334155",
    text: "#94a3b8",
    band: "rgba(147, 51, 234, 0.15)", // purple band
    onsetLine: "#a78bfa", // purple-400
    forecastBand: "rgba(251, 191, 36, 0.1)", // amber band
    forecastLine: "#fbbf24", // amber-400
    sleepDot: "#06b6d4", // cyan
    sleepDotTruncated: "#f59e0b", // amber
    midnight: "rgba(251, 191, 36, 0.25)", // subtle amber for 00:00 lines
};

const MARGINS = { top: 24, right: 16, bottom: 44, left: 56 };

// ── Data types ──

interface PhasePoint {
    date: Date;
    nightStart: number; // cumulative unwrapped hours
    nightEnd: number;
    localTau: number;
    confidence: number;
    isForecast: boolean;
}

interface SleepDot {
    date: Date;
    onset: number; // unwrapped to match phase coordinate system
    truncated: boolean;
}

// ── Helpers ──

/** Phase-unwrap an hour relative to a reference, minimizing jump */
function unwrapHour(hour: number, reference: number): number {
    let h = hour;
    while (h - reference > 12) h -= 24;
    while (h - reference < -12) h += 24;
    return h;
}

/** Format unwrapped hour as clock time (HH:MM) */
function formatClock(h: number): string {
    const normalized = ((h % 24) + 24) % 24;
    const hh = Math.floor(normalized);
    const mm = Math.floor((normalized - hh) * 60);
    return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
}

/** Format hour as day offset label (e.g., "0d", "+3d", "-2d") */
function formatDays(h: number, refHour: number): string {
    const days = Math.round((h - refHour) / 24);
    if (days === 0) return "0d";
    return (days > 0 ? "+" : "") + days + "d";
}

/** Compute fractional hour-of-day from a Date */
function hourOfDay(d: Date): number {
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** Build cumulative phase points from circadian analysis days */
function buildPhasePoints(days: CircadianDay[]): PhasePoint[] {
    const valid = days.filter((d) => !d.isGap);
    if (valid.length === 0) return [];

    const points: PhasePoint[] = [];
    let prevStart = 0;

    for (let i = 0; i < valid.length; i++) {
        const d = valid[i]!;
        const halfDur = (d.nightEndHour - d.nightStartHour) / 2;

        let nightStart: number;
        if (i === 0) {
            nightStart = d.nightStartHour;
        } else {
            nightStart = unwrapHour(d.nightStartHour, prevStart);
        }
        prevStart = nightStart;

        points.push({
            date: new Date(d.date + "T00:00:00"),
            nightStart,
            nightEnd: nightStart + halfDur * 2,
            localTau: d.localTau,
            confidence: d.confidenceScore,
            isForecast: d.isForecast,
        });
    }

    return points;
}

/** Build sleep onset dots, unwrapped to match the phase coordinate system */
function buildSleepDots(records: SleepRecord[], phasePoints: PhasePoint[]): SleepDot[] {
    if (phasePoints.length === 0) return [];

    const main = records
        .filter((r) => r.isMainSleep && r.durationHours >= 2)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    // Build a date→nightStart lookup from phase points for snapping
    const phaseByDate = new Map<string, number>();
    for (const p of phasePoints) {
        const key =
            p.date.getFullYear() +
            "-" +
            String(p.date.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(p.date.getDate()).padStart(2, "0");
        phaseByDate.set(key, p.nightStart);
    }

    // Compute average duration for truncation detection
    const avgDuration = main.reduce((sum, r) => sum + r.durationHours, 0) / main.length;
    const truncationThreshold = avgDuration - 1.5;

    return main.map((r) => {
        const sleepOnset = hourOfDay(r.startTime);

        const refOnset = phaseByDate.get(r.dateOfSleep);
        const onset = refOnset !== undefined ? unwrapHour(sleepOnset, refOnset) : sleepOnset;

        return {
            date: new Date(r.startTime.getFullYear(), r.startTime.getMonth(), r.startTime.getDate()),
            onset,
            truncated: r.durationHours < truncationThreshold,
        };
    });
}

// ── Component ──

export default function PhaseChart() {
    const { filteredRecords, showPhaseChart, circadianAnalysis, scheduleEntries, showSchedule } = useAppContext();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const phasePoints = useMemo(() => buildPhasePoints(circadianAnalysis.days), [circadianAnalysis.days]);

    const sleepDots = useMemo(() => buildSleepDots(filteredRecords, phasePoints), [filteredRecords, phasePoints]);

    const [height, setHeight] = usePersistedState("viz.phaseChartHeight", DEFAULT_HEIGHT);
    const [resizeKey, setResizeKey] = useState(0);

    // Drag-to-resize state
    const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!dragRef.current) return;
            const delta = e.clientY - dragRef.current.startY;
            const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, dragRef.current.startHeight + delta));
            setHeight(newHeight);
        };
        const handleMouseUp = () => {
            dragRef.current = null;
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);
        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [setHeight]);

    const handleDragStart = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragRef.current = { startY: e.clientY, startHeight: height };
            document.body.style.cursor = "ns-resize";
            document.body.style.userSelect = "none";
        },
        [height]
    );

    const [tooltip, setTooltip] = useState<{
        x: number;
        y: number;
        date: string;
        clock: string;
        localTau: string;
        confidence: string;
        isForecast: boolean;
    } | null>(null);

    // Render canvas
    useEffect(() => {
        if (!showPhaseChart) return;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || phasePoints.length === 0) return;

        const dpr = window.devicePixelRatio || 1;
        const width = container.clientWidth;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = height + "px";

        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, width, height);

        const plotLeft = MARGINS.left;
        const plotRight = width - MARGINS.right;
        const plotTop = MARGINS.top;
        const plotBottom = height - MARGINS.bottom;
        const plotWidth = plotRight - plotLeft;
        const plotHeight = plotBottom - plotTop;

        // Compute Y range from phase data (with padding)
        const allHours = phasePoints.flatMap((p) => [p.nightStart, p.nightEnd]);
        const dotHours = sleepDots.map((d) => d.onset);
        const allValues = [...allHours, ...dotHours];
        const minHour = Math.floor(Math.min(...allValues)) - 1;
        const maxHour = Math.ceil(Math.max(...allValues)) + 1;
        const hourSpan = maxHour - minHour;

        // Determine Y-axis mode: clock times vs day offsets
        const dayMode = hourSpan >= DAY_MODE_THRESHOLD;
        const refHour = dayMode ? Math.round(phasePoints[0]!.nightStart / 24) * 24 : 0;

        // X scale: date range
        const firstDate = phasePoints[0]!.date;
        const lastDate = phasePoints[phasePoints.length - 1]!.date;
        const xScale = scaleTime().domain([firstDate, lastDate]).range([plotLeft, plotRight]);

        // Y scale: cumulative phase hours (smaller at top, larger at bottom)
        const yScale = scaleLinear().domain([minHour, maxHour]).range([plotTop, plotBottom]);

        const msPerDay = 86_400_000;
        const totalDays = Math.round((lastDate.getTime() - firstDate.getTime()) / msPerDay);

        // ── Grid ──

        const gridInterval = dayMode ? (hourSpan > 240 ? 48 : 24) : hourSpan > 48 ? 12 : hourSpan > 24 ? 6 : 3;

        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        ctx.fillStyle = COLORS.text;
        ctx.font = "10px monospace";
        ctx.textAlign = "right";

        for (let h = Math.ceil(minHour / gridInterval) * gridInterval; h <= Math.floor(maxHour); h += gridInterval) {
            const y = yScale(h);
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotRight, y);
            ctx.stroke();
            const label = dayMode ? formatDays(h, refHour) : formatClock(h);
            ctx.fillText(label, plotLeft - 6, y + 4);
        }

        // Highlight midnight (00:00) lines when they'd be distinct from grid
        if (!dayMode && gridInterval < 24) {
            ctx.strokeStyle = COLORS.midnight;
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 4]);
            for (let h = Math.ceil(minHour / 24) * 24; h <= Math.floor(maxHour); h += 24) {
                if (h % gridInterval === 0) continue;
                const y = yScale(h);
                ctx.beginPath();
                ctx.moveTo(plotLeft, y);
                ctx.lineTo(plotRight, y);
                ctx.stroke();
            }
            ctx.setLineDash([]);
        }

        // Vertical grid lines — first of each month
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        const d = new Date(firstDate);
        d.setDate(1);
        d.setMonth(d.getMonth() + 1);
        while (d <= lastDate) {
            const x = xScale(d);
            if (x >= plotLeft && x <= plotRight) {
                ctx.beginPath();
                ctx.moveTo(x, plotTop);
                ctx.lineTo(x, plotBottom);
                ctx.stroke();
            }
            d.setMonth(d.getMonth() + 1);
        }

        // ── Schedule bands ──
        if (showSchedule && scheduleEntries.length > 0) {
            for (const entry of scheduleEntries) {
                const [sh, sm] = entry.startTime.split(":").map(Number);
                const [eh, em] = entry.endTime.split(":").map(Number);
                const schedStartRaw = sh! + sm! / 60;
                const schedEndRaw = eh! + em! / 60;
                const schedDur =
                    schedEndRaw > schedStartRaw ? schedEndRaw - schedStartRaw : schedEndRaw + 24 - schedStartRaw;

                ctx.fillStyle = "rgba(239, 68, 68, 0.08)";
                for (let base = Math.floor(minHour / 24) * 24; base <= maxHour; base += 24) {
                    const bandStart = base + schedStartRaw;
                    const bandEnd = bandStart + schedDur;
                    if (bandEnd < minHour || bandStart > maxHour) continue;
                    const y1 = yScale(Math.max(bandStart, minHour));
                    const y2 = yScale(Math.min(bandEnd, maxHour));
                    ctx.fillRect(plotLeft, y1, plotWidth, y2 - y1);
                }
            }
        }

        // ── Circadian band and onset line ──
        // Split into historical + forecast, with the last historical point duplicated
        // into the forecast array to avoid a visual gap at the transition.
        const historical = phasePoints.filter((p) => !p.isForecast);
        const lastHistorical = historical[historical.length - 1];
        const forecastRaw = phasePoints.filter((p) => p.isForecast);
        const forecast = lastHistorical && forecastRaw.length > 0 ? [lastHistorical, ...forecastRaw] : forecastRaw;

        const drawBand = (pts: PhasePoint[], color: string) => {
            if (pts.length < 2) return;
            ctx.fillStyle = color;
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i]!;
                const x = xScale(p.date);
                const y = yScale(p.nightStart);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            for (let i = pts.length - 1; i >= 0; i--) {
                const p = pts[i]!;
                ctx.lineTo(xScale(p.date), yScale(p.nightEnd));
            }
            ctx.closePath();
            ctx.fill();
        };

        drawBand(historical, COLORS.band);
        drawBand(forecast, COLORS.forecastBand);

        const drawOnsetLine = (pts: PhasePoint[], color: string) => {
            if (pts.length < 2) return;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([]);
            ctx.beginPath();
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i]!;
                const x = xScale(p.date);
                const y = yScale(p.nightStart);
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
            }
            ctx.stroke();
        };

        drawOnsetLine(historical, COLORS.onsetLine);
        if (forecast.length > 0) {
            ctx.setLineDash([6, 4]);
            drawOnsetLine(forecast, COLORS.forecastLine);
            ctx.setLineDash([]);
        }

        // ── Sleep onset dots ──
        // Scale dot size and opacity with data density; hide entirely for very long datasets
        if (totalDays < DOT_HIDE_THRESHOLD) {
            const pxPerDay = plotWidth / Math.max(1, totalDays);
            const dotRadius = Math.max(0.5, Math.min(3, pxPerDay / 2));
            // Fade opacity as dots get smaller: 0.6 at r>=2, down to 0.25 at r=0.5
            const dotAlpha = Math.min(0.6, 0.15 + dotRadius * 0.225);

            for (const dot of sleepDots) {
                const x = xScale(dot.date);
                if (x < plotLeft || x > plotRight) continue;
                const y = yScale(dot.onset);

                ctx.fillStyle = dot.truncated ? COLORS.sleepDotTruncated : COLORS.sleepDot;
                ctx.globalAlpha = dotAlpha;
                ctx.beginPath();
                ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }

        // ── Axes ──
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, plotBottom);
        ctx.lineTo(plotRight, plotBottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(plotLeft, plotTop);
        ctx.lineTo(plotLeft, plotBottom);
        ctx.stroke();

        // X axis labels
        ctx.fillStyle = COLORS.text;
        ctx.font = "10px monospace";
        ctx.textAlign = "center";

        const tickInterval =
            totalDays > 365 ? 90 : totalDays > 180 ? 60 : totalDays > 90 ? 30 : totalDays > 30 ? 14 : 7;

        const tickDate = new Date(firstDate);
        while (tickDate <= lastDate) {
            const x = xScale(tickDate);
            if (x >= plotLeft && x <= plotRight) {
                const label =
                    String(tickDate.getMonth() + 1).padStart(2, "0") +
                    "/" +
                    String(tickDate.getDate()).padStart(2, "0");
                ctx.fillText(label, x, plotBottom + 14);
            }
            tickDate.setDate(tickDate.getDate() + tickInterval);
        }

        // Axis titles
        ctx.fillStyle = COLORS.text;
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Date", plotLeft + plotWidth / 2, plotBottom + 32);

        ctx.save();
        ctx.translate(12, plotTop + plotHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText(dayMode ? "Phase (days)" : "Phase", 0, 0);
        ctx.restore();

        // Plot border
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
    }, [phasePoints, sleepDots, showPhaseChart, showSchedule, scheduleEntries, height, resizeKey]);

    // Resize handler
    useEffect(() => {
        if (!showPhaseChart) return;
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver(() => setResizeKey((k) => k + 1));
        observer.observe(container);
        return () => observer.disconnect();
    }, [showPhaseChart]);

    // Tooltip handler
    const getTooltipInfo = useCallback(
        (canvasX: number) => {
            if (phasePoints.length === 0) return null;

            const canvas = canvasRef.current;
            if (!canvas) return null;

            const width = canvas.clientWidth;
            const plotLeft = MARGINS.left;
            const plotRight = width - MARGINS.right;

            const firstDate = phasePoints[0]!.date;
            const lastDate = phasePoints[phasePoints.length - 1]!.date;
            const xScale = scaleTime().domain([firstDate, lastDate]).range([plotLeft, plotRight]);

            const hoverDate = xScale.invert(canvasX);
            const hoverMs = hoverDate.getTime();

            let closest = phasePoints[0]!;
            let minDist = Infinity;
            for (const p of phasePoints) {
                const dist = Math.abs(p.date.getTime() - hoverMs);
                if (dist < minDist) {
                    minDist = dist;
                    closest = p;
                }
            }

            if (minDist > 2 * 86_400_000) return null;

            const dateStr =
                closest.date.getFullYear() +
                "-" +
                String(closest.date.getMonth() + 1).padStart(2, "0") +
                "-" +
                String(closest.date.getDate()).padStart(2, "0");

            return {
                date: dateStr,
                clock: formatClock(closest.nightStart) + " – " + formatClock(closest.nightEnd),
                localTau: closest.localTau.toFixed(2) + "h",
                confidence: Math.round(closest.confidence * 100) + "%",
                isForecast: closest.isForecast,
            };
        },
        [phasePoints]
    );

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const info = getTooltipInfo(x);
            if (info) {
                setTooltip({ x: e.clientX, y: e.clientY, ...info });
            } else {
                setTooltip(null);
            }
        },
        [getTooltipInfo]
    );

    const handleMouseLeave = useCallback(() => setTooltip(null), []);

    if (!showPhaseChart || phasePoints.length === 0) return null;

    return (
        <div className="relative mt-4" ref={containerRef}>
            <canvas
                id="phasechart-canvas"
                ref={canvasRef}
                className="w-full cursor-crosshair"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
            />
            {/* Drag handle for vertical resize */}
            <div
                onMouseDown={handleDragStart}
                className="flex h-2 cursor-ns-resize items-center justify-center rounded-b bg-slate-700/50 hover:bg-slate-600/50"
            >
                <div className="h-0.5 w-8 rounded-full bg-slate-500" />
            </div>
            {tooltip && (
                <div
                    className="pointer-events-none fixed z-50 rounded bg-gray-900 px-3 py-2 text-xs text-gray-200 shadow-lg"
                    style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
                >
                    <div>
                        <span className="text-gray-400">date: </span>
                        {tooltip.date}
                        {tooltip.isForecast && <span className="ml-1 text-amber-400">(forecast)</span>}
                    </div>
                    <div>
                        <span className="text-gray-400">window: </span>
                        {tooltip.clock}
                    </div>
                    <div>
                        <span className="text-gray-400">tau: </span>
                        {tooltip.localTau}
                    </div>
                    <div>
                        <span className="text-gray-400">confidence: </span>
                        {tooltip.confidence}
                    </div>
                </div>
            )}
        </div>
    );
}
