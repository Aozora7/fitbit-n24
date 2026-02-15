import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { scaleLinear } from "d3-scale";
import { useAppContext } from "../useAppContext";
import { computeLombScargle, type PeriodogramResult } from "../models/lombScargle";

const COLORS = {
    background: "#1e293b",
    grid: "#334155",
    text: "#94a3b8",
    line: "#06b6d4",
    peak: "#f59e0b",
    reference24: "#64748b",
    significance: "#ef4444",
};

const MARGINS = { top: 24, right: 16, bottom: 36, left: 56 };
const HEIGHT = 200;

export default function Periodogram() {
    const { circadianAnalysis, showPeriodogram } = useAppContext();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const result = useMemo<PeriodogramResult>(
        () => computeLombScargle(circadianAnalysis.anchors),
        [circadianAnalysis.anchors]
    );

    const [resizeKey, setResizeKey] = useState(0);

    const [tooltip, setTooltip] = useState<{
        x: number;
        y: number;
        period: string;
        power: string;
    } | null>(null);

    // Render canvas
    useEffect(() => {
        if (!showPeriodogram) return;
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container || result.trimmedPoints.length === 0) return;

        const dpr = window.devicePixelRatio || 1;
        const width = container.clientWidth;
        canvas.width = width * dpr;
        canvas.height = HEIGHT * dpr;
        canvas.style.width = width + "px";
        canvas.style.height = HEIGHT + "px";

        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, width, HEIGHT);

        const plotLeft = MARGINS.left;
        const plotRight = width - MARGINS.right;
        const plotTop = MARGINS.top;
        const plotBottom = HEIGHT - MARGINS.bottom;
        const plotWidth = plotRight - plotLeft;
        const plotHeight = plotBottom - plotTop;

        // Scales — use trimmed range for display
        const displayPoints = result.trimmedPoints;
        const minP = displayPoints[0]!.period;
        const maxP = displayPoints[displayPoints.length - 1]!.period;
        const maxPow = Math.max(result.peakPower * 1.1, result.significanceThreshold * 1.5, 1);

        const xScale = scaleLinear().domain([minP, maxP]).range([plotLeft, plotRight]);
        const yScale = scaleLinear().domain([0, maxPow]).range([plotBottom, plotTop]);

        // Grid lines — vertical at integer hours
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.setLineDash([]);
        for (let h = Math.ceil(minP); h <= Math.floor(maxP); h++) {
            const x = xScale(h);
            ctx.beginPath();
            ctx.moveTo(x, plotTop);
            ctx.lineTo(x, plotBottom);
            ctx.stroke();
        }

        // Grid lines — horizontal at power intervals
        const powerStep = maxPow > 10 ? 5 : maxPow > 4 ? 2 : maxPow > 1.5 ? 0.5 : 0.2;
        for (let p = powerStep; p < maxPow; p += powerStep) {
            const y = yScale(p);
            ctx.beginPath();
            ctx.moveTo(plotLeft, y);
            ctx.lineTo(plotRight, y);
            ctx.stroke();
        }

        // Significance threshold line
        ctx.strokeStyle = COLORS.significance;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        const sigY = yScale(result.significanceThreshold);
        if (sigY > plotTop && sigY < plotBottom) {
            ctx.beginPath();
            ctx.moveTo(plotLeft, sigY);
            ctx.lineTo(plotRight, sigY);
            ctx.stroke();
            ctx.fillStyle = COLORS.significance;
            ctx.font = "10px monospace";
            ctx.textAlign = "right";
            ctx.fillText("p<0.01", plotRight, sigY - 3);
        }

        // 24h reference line
        ctx.strokeStyle = COLORS.reference24;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        const x24 = xScale(24);
        if (x24 >= plotLeft && x24 <= plotRight) {
            ctx.beginPath();
            ctx.moveTo(x24, plotTop);
            ctx.lineTo(x24, plotBottom);
            ctx.stroke();
            ctx.fillStyle = COLORS.reference24;
            ctx.font = "10px monospace";
            ctx.textAlign = "center";
            ctx.fillText("24h", x24, plotTop - 4);
        }

        // Peak marker
        ctx.strokeStyle = COLORS.peak;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 3]);
        const xPeak = xScale(result.peakPeriod);
        ctx.beginPath();
        ctx.moveTo(xPeak, plotTop);
        ctx.lineTo(xPeak, plotBottom);
        ctx.stroke();
        ctx.fillStyle = COLORS.peak;
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        ctx.fillText(result.peakPeriod.toFixed(2) + "h", xPeak, plotTop - 4);

        // Power spectrum curve
        ctx.setLineDash([]);
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (let i = 0; i < displayPoints.length; i++) {
            const pt = displayPoints[i]!;
            const x = xScale(pt.period);
            const y = yScale(pt.power);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Fill under curve
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = COLORS.line;
        ctx.lineTo(xScale(displayPoints[displayPoints.length - 1]!.period), plotBottom);
        ctx.lineTo(xScale(displayPoints[0]!.period), plotBottom);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;

        // Axes
        ctx.strokeStyle = COLORS.text;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        // X axis
        ctx.beginPath();
        ctx.moveTo(plotLeft, plotBottom);
        ctx.lineTo(plotRight, plotBottom);
        ctx.stroke();
        // Y axis
        ctx.beginPath();
        ctx.moveTo(plotLeft, plotTop);
        ctx.lineTo(plotLeft, plotBottom);
        ctx.stroke();

        // X axis labels
        ctx.fillStyle = COLORS.text;
        ctx.font = "11px monospace";
        ctx.textAlign = "center";
        for (let h = Math.ceil(minP); h <= Math.floor(maxP); h++) {
            ctx.fillText(h + "h", xScale(h), plotBottom + 14);
        }
        ctx.fillText("Period (hours)", plotLeft + plotWidth / 2, plotBottom + 28);

        // Y axis labels
        ctx.textAlign = "right";
        for (let p = 0; p <= maxPow; p += powerStep) {
            const y = yScale(p);
            if (y >= plotTop && y <= plotBottom) {
                ctx.fillText(p.toFixed(1), plotLeft - 6, y + 4);
            }
        }
        ctx.save();
        ctx.translate(12, plotTop + plotHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = "center";
        ctx.fillText("Power", 0, 0);
        ctx.restore();

        // Plot border
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(plotLeft, plotTop, plotWidth, plotHeight);
    }, [result, showPeriodogram, resizeKey]);

    // Resize handler
    useEffect(() => {
        if (!showPeriodogram) return;
        const container = containerRef.current;
        if (!container) return;

        const observer = new ResizeObserver(() => setResizeKey((k) => k + 1));
        observer.observe(container);
        return () => observer.disconnect();
    }, [showPeriodogram]);

    // Tooltip handler
    const getTooltipInfo = useCallback(
        (canvasX: number): { period: string; power: string } | null => {
            if (result.trimmedPoints.length === 0) return null;

            const canvas = canvasRef.current;
            if (!canvas) return null;

            const width = canvas.clientWidth;
            const plotLeft = MARGINS.left;
            const plotRight = width - MARGINS.right;

            const minP = result.trimmedPoints[0]!.period;
            const maxP = result.trimmedPoints[result.trimmedPoints.length - 1]!.period;
            const xScale = scaleLinear().domain([minP, maxP]).range([plotLeft, plotRight]);

            const period = xScale.invert(canvasX);
            if (period < minP || period > maxP) return null;

            // Find closest point
            let closest = result.trimmedPoints[0]!;
            let minDist = Infinity;
            for (const pt of result.trimmedPoints) {
                const d = Math.abs(pt.period - period);
                if (d < minDist) {
                    minDist = d;
                    closest = pt;
                }
            }

            return {
                period: closest.period.toFixed(2) + "h",
                power: closest.power.toFixed(3),
            };
        },
        [result]
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

    if (!showPeriodogram || result.trimmedPoints.length === 0) return null;

    return (
        <div className="relative mt-4" ref={containerRef}>
            <canvas
                ref={canvasRef}
                className="w-full cursor-crosshair"
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
            />
            {tooltip && (
                <div
                    className="pointer-events-none fixed z-50 rounded bg-gray-900 px-3 py-2 text-xs text-gray-200 shadow-lg"
                    style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
                >
                    <div>
                        <span className="text-gray-400">period: </span>
                        {tooltip.period}
                    </div>
                    <div>
                        <span className="text-gray-400">power: </span>
                        {tooltip.power}
                    </div>
                </div>
            )}
        </div>
    );
}
