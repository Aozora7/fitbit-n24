import { useState, useCallback, useMemo, useRef } from "react";
import { useActogramRenderer } from "./useActogramRenderer";
import { useOverlayEditor, EDITOR_GUTTER } from "./useOverlayEditor";
import { buildActogramRows, buildTauRows } from "../../models/actogramData";
import { useAppContext } from "../../useAppContext";

export default function Actogram() {
    const {
        filteredRecords,
        showCircadian,
        circadianAnalysis,
        doublePlot,
        effectiveRowHeight,
        colorMode,
        tauHours,
        forecastDays,
        forecastDisabled,
        showSchedule,
        scheduleEntries,
        overlayEditMode,
        overlayControlPoints,
        setOverlayControlPoints,
        manualOverlayDays,
        sortDirection,
        showDateLabels,
    } = useAppContext();

    const effectiveForecastDays = forecastDisabled ? 0 : forecastDays;

    const rows = useMemo(
        () =>
            tauHours !== 24
                ? buildTauRows(filteredRecords, tauHours, effectiveForecastDays, sortDirection)
                : buildActogramRows(filteredRecords, effectiveForecastDays, sortDirection),
        [filteredRecords, effectiveForecastDays, tauHours, sortDirection]
    );

    const circadianDays = showCircadian ? circadianAnalysis.days : [];

    // Editor is active only in calendar mode with circadian overlay shown
    const editorActive = import.meta.env.DEV && overlayEditMode && showCircadian && tauHours === 24;

    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Base left margin depends on label visibility and row-width mode.
    // Editor gutter is added on top when the overlay editor is active.
    const labelMargin = !showDateLabels ? 16 : tauHours !== 24 ? 110 : 80;
    const sideMargin = 16;
    const leftMargin = editorActive ? labelMargin + EDITOR_GUTTER : labelMargin;

    const rendererConfig = useMemo(
        () => ({
            doublePlot,
            rowHeight: effectiveRowHeight,
            colorMode,
            tauHours,
            showSchedule,
            scheduleEntries,
            sortDirection,
            showDateLabels,
            leftMargin,
            rightMargin: sideMargin,
        }),
        [
            doublePlot,
            effectiveRowHeight,
            colorMode,
            tauHours,
            showSchedule,
            scheduleEntries,
            sortDirection,
            showDateLabels,
            leftMargin,
            sideMargin,
        ]
    );

    const editorConfig = useMemo(
        () => ({
            doublePlot,
            rowHeight: effectiveRowHeight,
            colorMode,
            tauHours,
            leftMargin,
            topMargin: 30,
            rightMargin: sideMargin,
            bottomMargin: 20,
        }),
        [doublePlot, effectiveRowHeight, colorMode, tauHours, leftMargin, sideMargin]
    );

    const editor = useOverlayEditor(
        canvasRef,
        rows,
        editorConfig,
        overlayControlPoints,
        setOverlayControlPoints,
        editorActive
    );

    const { getTooltipInfo } = useActogramRenderer(rows, circadianDays, rendererConfig, {
        manualOverlayDays: manualOverlayDays.length > 0 ? manualOverlayDays : undefined,
        overlayEditMode: editorActive,
        editorDraw: editorActive ? editor.drawEditor : undefined,
        canvasRef,
    });

    const [tooltip, setTooltip] = useState<{
        x: number;
        y: number;
        info: Record<string, string>;
    } | null>(null);

    const handleMouseMove = useCallback(
        (e: React.MouseEvent<HTMLCanvasElement>) => {
            // In edit mode, forward to editor first (for drag handling)
            if (editorActive) {
                editor.onMouseMove(e);
            }
            // Always do tooltip hit-testing (sleep records only in edit mode)
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const info = getTooltipInfo(x, y);
            // In edit mode, only show tooltip for sleep records (has "start" key), not bare date-only
            const showTip = info && (!editorActive || "start" in info);
            if (showTip) {
                setTooltip({ x: e.clientX, y: e.clientY, info });
            } else {
                setTooltip(null);
            }
        },
        [getTooltipInfo, editorActive, editor.onMouseMove]
    );

    const handleMouseLeave = useCallback(() => setTooltip(null), []);

    return (
        <div className="relative">
            <canvas
                id="actogram-canvas"
                ref={canvasRef}
                className="w-full cursor-crosshair"
                onMouseDown={editorActive ? editor.onMouseDown : undefined}
                onMouseMove={handleMouseMove}
                onMouseUp={editorActive ? editor.onMouseUp : undefined}
                onContextMenu={editorActive ? editor.onContextMenu : undefined}
                onMouseLeave={handleMouseLeave}
            />
            {tooltip && (
                <div
                    className="pointer-events-none fixed z-50 rounded bg-gray-900 px-3 py-2 text-xs text-gray-200 shadow-lg"
                    style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
                >
                    {Object.entries(tooltip.info).map(([key, val]) => (
                        <div key={key}>
                            <span className="text-gray-400">{key}: </span>
                            {val}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
