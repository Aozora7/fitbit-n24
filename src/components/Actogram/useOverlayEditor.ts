import { useCallback, useRef } from "react";
import { scaleLinear } from "d3-scale";
import type { ActogramRow } from "../../models/actogramData";
import type { ActogramConfig } from "./useActogramRenderer";
import type { OverlayControlPoint } from "../../models/overlayPath";
import { unwrapMidpointForEditor } from "../../models/overlayPath";

/** Gutter width added to the left of the actogram for editor handles */
export const EDITOR_GUTTER = 20;

const HANDLE_RADIUS = 5;
const HIT_RADIUS = 10;
const PATH_COLOR = "rgba(6, 182, 212, 0.8)"; // cyan
const HANDLE_COLOR = "#06b6d4";
const HANDLE_STROKE = "#0e7490";
const DRAG_PREVIEW_COLOR = "rgba(6, 182, 212, 0.5)";

interface DragState {
    /** Index into controlPoints being dragged */
    idx: number;
    /** Current preview position (CSS pixels) */
    previewX: number;
    previewY: number;
}

/**
 * Hook for interactive overlay editing on the actogram canvas.
 *
 * When enabled, provides event handlers (attach to the canvas) and a draw
 * function (call from the renderer useEffect after all other layers).
 *
 * Only works in calendar mode (tauHours === 24).
 */
export function useOverlayEditor(
    canvasRef: React.RefObject<HTMLCanvasElement | null>,
    rows: ActogramRow[],
    config: ActogramConfig,
    controlPoints: OverlayControlPoint[],
    setControlPoints: (
        updater: OverlayControlPoint[] | ((prev: OverlayControlPoint[]) => OverlayControlPoint[]),
    ) => void,
    enabled: boolean,
) {
    const dragRef = useRef<DragState | null>(null);

    const baseHours = config.tauHours !== 24 ? config.tauHours : 24;
    const hoursPerRow = config.doublePlot ? baseHours * 2 : baseHours;

    // ── Coordinate helpers ──────────────────────────────────────────

    /** Build xScale matching the renderer's scale (CSS pixel space, not device pixels) */
    const getXScale = useCallback(() => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        const cssWidth = canvas.clientWidth;
        const plotLeft = config.leftMargin;
        const plotWidth = cssWidth - config.leftMargin - config.rightMargin;
        return scaleLinear()
            .domain([0, hoursPerRow])
            .range([plotLeft, plotLeft + plotWidth]);
    }, [canvasRef, config.leftMargin, config.rightMargin, hoursPerRow]);

    /** Convert CSS (x,y) on canvas → { rowIdx, hour, date } */
    const pixelToCoord = useCallback(
        (canvasX: number, canvasY: number) => {
            const xScale = getXScale();
            if (!xScale) return null;

            const rowIdx = Math.floor((canvasY - config.topMargin) / config.rowHeight);
            if (rowIdx < 0 || rowIdx >= rows.length) return null;

            const hour = xScale.invert(canvasX);
            // In double-plot, normalize to base hours (same day on both halves for circadian)
            const normalizedHour = ((hour % baseHours) + baseHours) % baseHours;
            const date = rows[rowIdx]!.date.slice(0, 10);

            return { rowIdx, hour: normalizedHour, date };
        },
        [getXScale, config.topMargin, config.rowHeight, rows, baseHours],
    );

    /** Convert a control point → CSS pixel position (using normalized hour for display) */
    const cpToPixel = useCallback(
        (cp: OverlayControlPoint): { x: number; y: number } | null => {
            const xScale = getXScale();
            if (!xScale) return null;

            const rowIdx = rows.findIndex((r) => r.date.slice(0, 10) === cp.date);
            if (rowIdx < 0) return null;

            const normalizedHour = ((cp.midpointHour % 24) + 24) % 24;
            const x = xScale(normalizedHour);
            const y = config.topMargin + rowIdx * config.rowHeight + config.rowHeight / 2;

            return { x, y };
        },
        [getXScale, rows, config.topMargin, config.rowHeight],
    );

    /** Get the row Y center for a given date string */
    const dateToY = useCallback(
        (date: string): number | null => {
            const rowIdx = rows.findIndex((r) => r.date.slice(0, 10) === date);
            if (rowIdx < 0) return null;
            return config.topMargin + rowIdx * config.rowHeight + config.rowHeight / 2;
        },
        [rows, config.topMargin, config.rowHeight],
    );

    // ── Hit-testing ─────────────────────────────────────────────────

    /** Find control point index near the given CSS pixel position, or -1 */
    const hitTestHandle = useCallback(
        (canvasX: number, canvasY: number): number => {
            for (let i = 0; i < controlPoints.length; i++) {
                const pos = cpToPixel(controlPoints[i]!);
                if (!pos) continue;

                // Check both the gutter handle and the plot-area position
                const gutterX = config.leftMargin - EDITOR_GUTTER / 2;
                const plotX = pos.x;
                const py = pos.y;

                const distGutter = Math.hypot(canvasX - gutterX, canvasY - py);
                const distPlot = Math.hypot(canvasX - plotX, canvasY - py);

                if (distGutter <= HIT_RADIUS || distPlot <= HIT_RADIUS) {
                    return i;
                }
            }
            return -1;
        },
        [controlPoints, cpToPixel, config.leftMargin],
    );

    // ── Event handlers ──────────────────────────────────────────────

    const onMouseDown = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (!enabled) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const hitIdx = hitTestHandle(cx, cy);
            if (hitIdx >= 0) {
                // Start dragging existing point
                dragRef.current = { idx: hitIdx, previewX: cx, previewY: cy };
                e.preventDefault();
                return;
            }

            // Click on plot area → add new control point
            const coord = pixelToCoord(cx, cy);
            if (!coord) return;

            // Phase-unwrap relative to nearest existing neighbor
            let midpointHour = coord.hour;
            if (controlPoints.length > 0) {
                // Find the neighbor closest in date
                const sorted = [...controlPoints].sort((a, b) => a.date.localeCompare(b.date));
                let closestIdx = 0;
                let closestDist = Infinity;
                for (let i = 0; i < sorted.length; i++) {
                    const dist = Math.abs(daysBetween(sorted[i]!.date, coord.date));
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestIdx = i;
                    }
                }
                midpointHour = unwrapMidpointForEditor(
                    midpointHour,
                    sorted[closestIdx]!.midpointHour,
                    daysBetween(sorted[closestIdx]!.date, coord.date),
                );
            }

            setControlPoints((prev) => [...prev, { date: coord.date, midpointHour }]);
        },
        [enabled, hitTestHandle, pixelToCoord, controlPoints, setControlPoints],
    );

    const onMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (!enabled || !dragRef.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            dragRef.current.previewX = e.clientX - rect.left;
            dragRef.current.previewY = e.clientY - rect.top;
            canvasRef.current?.dispatchEvent(new Event("editor-drag"));
        },
        [enabled, canvasRef],
    );

    const onMouseUp = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (!enabled || !dragRef.current) return;
            const drag = dragRef.current;
            dragRef.current = null;

            const rect = e.currentTarget.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const coord = pixelToCoord(cx, cy);
            if (!coord) return;

            // Phase-unwrap relative to neighbors (excluding the dragged point)
            const otherPoints = controlPoints.filter((_, i) => i !== drag.idx);
            let midpointHour = coord.hour;
            if (otherPoints.length > 0) {
                const sorted = [...otherPoints].sort((a, b) => a.date.localeCompare(b.date));
                let closestIdx = 0;
                let closestDist = Infinity;
                for (let i = 0; i < sorted.length; i++) {
                    const dist = Math.abs(daysBetween(sorted[i]!.date, coord.date));
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestIdx = i;
                    }
                }
                midpointHour = unwrapMidpointForEditor(
                    midpointHour,
                    sorted[closestIdx]!.midpointHour,
                    daysBetween(sorted[closestIdx]!.date, coord.date),
                );
            }

            setControlPoints((prev) =>
                prev.map((cp, i) => (i === drag.idx ? { date: coord.date, midpointHour } : cp)),
            );
        },
        [enabled, pixelToCoord, controlPoints, setControlPoints],
    );

    const onContextMenu = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            if (!enabled) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;

            const hitIdx = hitTestHandle(cx, cy);
            if (hitIdx >= 0) {
                e.preventDefault();
                setControlPoints((prev) => prev.filter((_, i) => i !== hitIdx));
            }
        },
        [enabled, hitTestHandle, setControlPoints],
    );

    // ── Draw function ───────────────────────────────────────────────

    /**
     * Draw editor overlay (control point handles + connecting path line).
     * Called from the renderer after all other layers.
     *
     * The path line handles wrap-around: when consecutive unwrapped midpoints
     * cross a 24h boundary, the line exits one edge and re-enters the other,
     * rather than drawing a diagonal backwards across the canvas.
     */
    const drawEditor = useCallback(
        (ctx: CanvasRenderingContext2D, xScale: (h: number) => number, _plotTop: number) => {
            if (!enabled || controlPoints.length === 0) return;

            const sorted = [...controlPoints]
                .map((cp, origIdx) => ({ cp, origIdx }))
                .sort((a, b) => a.cp.date.localeCompare(b.cp.date));

            // ── Draw connecting path with wrap-around handling ──────
            ctx.save();
            ctx.strokeStyle = PATH_COLOR;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 3]);

            // Walk consecutive pairs and handle wrap-around
            for (let i = 0; i < sorted.length - 1; i++) {
                const a = sorted[i]!;
                const b = sorted[i + 1]!;
                const ay = dateToY(a.cp.date);
                const by = dateToY(b.cp.date);
                if (ay == null || by == null) continue;

                const aHour = a.cp.midpointHour;
                const bHour = b.cp.midpointHour;

                // Check if the line between these two unwrapped midpoints
                // crosses a 24h boundary when normalized
                const aNorm = ((aHour % 24) + 24) % 24;
                const bNorm = ((bHour % 24) + 24) % 24;
                const crossesBoundary = Math.floor(aHour / 24) !== Math.floor(bHour / 24);

                if (!crossesBoundary || Math.abs(bHour - aHour) < 12) {
                    // No wrap or the points are close enough — simple line
                    // But still need to handle the visual wrap when normalized positions
                    // are on opposite sides of the canvas
                    const unwrappedDiff = bHour - aHour;
                    if (Math.abs(bNorm - aNorm) > 12 && Math.abs(unwrappedDiff) < 12) {
                        // Points are close in unwrapped space but far in normalized space
                        // → the path wraps around the edge
                        drawWrappingSegment(ctx, xScale, aNorm, ay, bNorm, by, unwrappedDiff > 0);
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(xScale(aNorm), ay);
                        ctx.lineTo(xScale(bNorm), by);
                        ctx.stroke();
                    }
                } else {
                    // Crosses a 24h boundary — draw as wrapping segment
                    drawWrappingSegment(ctx, xScale, aNorm, ay, bNorm, by, bHour > aHour);
                }
            }

            ctx.setLineDash([]);
            ctx.restore();

            // ── Draw handles at each control point ──────────────────
            for (const { cp, origIdx } of sorted) {
                const pos = cpToPixel(cp);
                if (!pos) continue;

                const isDragging = dragRef.current?.idx === origIdx;

                // Plot-area handle (on the path line)
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fillStyle = isDragging ? DRAG_PREVIEW_COLOR : HANDLE_COLOR;
                ctx.fill();
                ctx.strokeStyle = HANDLE_STROKE;
                ctx.lineWidth = 1;
                ctx.stroke();

                // Gutter handle (easier to grab)
                const gutterX = config.leftMargin - EDITOR_GUTTER / 2;
                ctx.beginPath();
                ctx.arc(gutterX, pos.y, HANDLE_RADIUS - 1, 0, Math.PI * 2);
                ctx.fillStyle = isDragging ? DRAG_PREVIEW_COLOR : HANDLE_COLOR;
                ctx.fill();
                ctx.strokeStyle = HANDLE_STROKE;
                ctx.stroke();
            }

            // ── Draw drag preview ───────────────────────────────────
            if (dragRef.current) {
                const { previewX, previewY } = dragRef.current;
                ctx.beginPath();
                ctx.arc(previewX, previewY, HANDLE_RADIUS + 2, 0, Math.PI * 2);
                ctx.fillStyle = DRAG_PREVIEW_COLOR;
                ctx.fill();
                ctx.strokeStyle = HANDLE_COLOR;
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
        },
        [enabled, controlPoints, cpToPixel, dateToY, config.leftMargin],
    );

    return {
        onMouseDown,
        onMouseMove,
        onMouseUp,
        onContextMenu,
        drawEditor,
        dragRef,
    };
}

// ── Drawing helpers ─────────────────────────────────────────────────

/**
 * Draw a line segment between two points that wraps around the 24h boundary.
 *
 * Instead of drawing a diagonal line backwards across the canvas, the line
 * exits the right edge (hour 24) and re-enters from the left (hour 0), or
 * vice versa. The crossover Y position is linearly interpolated.
 */
function drawWrappingSegment(
    ctx: CanvasRenderingContext2D,
    xScale: (h: number) => number,
    aNorm: number,
    ay: number,
    bNorm: number,
    by: number,
    forward: boolean,
) {
    // forward = drifting later (right edge → left edge)
    // !forward = drifting earlier (left edge → right edge)
    if (forward) {
        // a is near 24, b is near 0 (unwrapped b > a, wrapping forward)
        const distToEdge = 24 - aNorm; // how far a is from the right edge
        const distFromEdge = bNorm; // how far b is from the left edge
        const totalDist = distToEdge + distFromEdge;
        const t = totalDist > 0 ? distToEdge / totalDist : 0.5;
        const crossY = ay + t * (by - ay);

        // Line from a → right edge
        ctx.beginPath();
        ctx.moveTo(xScale(aNorm), ay);
        ctx.lineTo(xScale(24), crossY);
        ctx.stroke();

        // Line from left edge → b
        ctx.beginPath();
        ctx.moveTo(xScale(0), crossY);
        ctx.lineTo(xScale(bNorm), by);
        ctx.stroke();
    } else {
        // a is near 0, b is near 24 (unwrapped b < a, wrapping backward)
        const distToEdge = aNorm; // how far a is from the left edge
        const distFromEdge = 24 - bNorm; // how far b is from the right edge
        const totalDist = distToEdge + distFromEdge;
        const t = totalDist > 0 ? distToEdge / totalDist : 0.5;
        const crossY = ay + t * (by - ay);

        // Line from a → left edge
        ctx.beginPath();
        ctx.moveTo(xScale(aNorm), ay);
        ctx.lineTo(xScale(0), crossY);
        ctx.stroke();

        // Line from right edge → b
        ctx.beginPath();
        ctx.moveTo(xScale(24), crossY);
        ctx.lineTo(xScale(bNorm), by);
        ctx.stroke();
    }
}

// ── Utility ─────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
    const da = new Date(a + "T00:00:00");
    const db = new Date(b + "T00:00:00");
    return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}
