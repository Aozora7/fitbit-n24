import { useMemo, useState } from "react";
import { useAppContext } from "../useAppContext";
import { listAlgorithms } from "../models/circadian";
import type { ColorMode } from "./Actogram/useActogramRenderer";
import { usePersistedState } from "../usePersistedState";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
            <div className="relative">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onChange(e.target.checked)}
                    className="peer sr-only"
                />
                <div className="h-5 w-9 rounded-full bg-slate-600 transition-colors peer-checked:bg-indigo-600 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-slate-900" />
                <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-slate-300 transition-transform peer-checked:translate-x-4 peer-checked:bg-white" />
            </div>
            {label}
        </label>
    );
}

function SegmentedControl<T extends string | number>({
    value,
    options,
    onChange,
    disabled = false,
}: {
    value: T;
    options: { key: T; label: string }[];
    onChange: (key: T) => void;
    disabled?: boolean;
}) {
    return (
        <div
            className={`inline-flex overflow-hidden rounded-md border border-slate-600${disabled ? " opacity-40 pointer-events-none" : ""}`}
        >
            {options.map((opt, i) => (
                <button
                    key={String(opt.key)}
                    onClick={() => onChange(opt.key)}
                    disabled={disabled}
                    className={`px-2.5 py-0.5 text-xs font-medium transition-colors ${
                        value === opt.key ? "bg-indigo-600 text-white" : "bg-slate-700 text-gray-300 hover:bg-slate-600"
                    }${i > 0 ? " border-l border-slate-600" : ""}${disabled ? " cursor-not-allowed" : ""}`}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

type TauMode = "24h" | "tau" | "custom";

function RowWidthControl() {
    const { tauHours, setTauHours, circadianAnalysis } = useAppContext();
    const globalTau = parseFloat(circadianAnalysis.globalTau.toFixed(2));
    const hasTau = globalTau !== 24;
    const [forceCustom, setForceCustom] = useState(false);

    const mode: TauMode = useMemo(() => {
        if (forceCustom) return "custom";
        if (tauHours === 24) return "24h";
        if (hasTau && tauHours === globalTau) return "tau";
        return "custom";
    }, [tauHours, globalTau, hasTau, forceCustom]);

    const segments: { key: TauMode; label: string }[] = [
        { key: "24h", label: "24h" },
        ...(hasTau ? [{ key: "tau" as TauMode, label: `τ ${globalTau}` }] : []),
        { key: "custom", label: "Custom" },
    ];

    const handleSegment = (key: TauMode) => {
        if (key === "24h") {
            setTauHours(24);
            setForceCustom(false);
        } else if (key === "tau") {
            setTauHours(globalTau);
            setForceCustom(false);
        } else setForceCustom(true);
    };

    return (
        <div className="flex items-center gap-2 text-sm text-gray-300">
            Row width
            <SegmentedControl value={mode} options={segments} onChange={handleSegment} />
            {mode === "custom" && (
                <input
                    type="number"
                    min={23}
                    max={26}
                    step={0.01}
                    value={tauHours}
                    onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 23 && v <= 26) setTauHours(v);
                    }}
                    className="w-20 rounded bg-slate-700 px-2 py-0.5 text-sm font-mono text-gray-300"
                />
            )}
        </div>
    );
}

export default function VisualizationControls() {
    const {
        doublePlot,
        setDoublePlot,
        showCircadian,
        setShowCircadian,
        showPeriodogram,
        setShowPeriodogram,
        showSchedule,
        setShowSchedule,
        showScheduleEditor,
        setShowScheduleEditor,
        colorMode,
        setColorMode,
        effectiveRowHeight,
        maxRowHeight,
        setRowHeight,
        forecastDays,
        setForecastDays,
        forecastDisabled,
        tauHours,
        overlayEditMode,
        setOverlayEditMode,
        overlayControlPoints,
        setOverlayControlPoints,
        overlaySleepWindow,
        setOverlaySleepWindow,
        circadianAlgorithmId,
        setCircadianAlgorithmId,
    } = useAppContext();

    const algorithms = listAlgorithms();
    const selectedAlgorithm = algorithms.find((a) => a.id === circadianAlgorithmId);

    const [collapsed, setCollapsed] = usePersistedState("viz.collapseControls", false);

    return (
        <div className="mx-auto mb-4 max-w-5xl rounded-lg border border-slate-700/50 bg-slate-800/60 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {!collapsed && (
                    <>
                        {/* ── Display ── */}
                        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Display</span>
                        <Toggle checked={doublePlot} onChange={setDoublePlot} label="Double plot" />
                        <Toggle checked={showCircadian} onChange={setShowCircadian} label="Circadian overlay" />
                        {showCircadian && import.meta.env.DEV && algorithms.length > 1 && (
                            <label className="flex items-center gap-2 text-sm text-gray-300">
                                Algorithm
                                <select
                                    value={circadianAlgorithmId}
                                    onChange={(e) => setCircadianAlgorithmId(e.target.value)}
                                    className="rounded bg-slate-700 px-2 py-0.5 text-sm text-gray-300"
                                    title={selectedAlgorithm?.description}
                                >
                                    {algorithms.map((algo) => (
                                        <option key={algo.id} value={algo.id}>
                                            {algo.name}
                                        </option>
                                    ))}
                                </select>
                            </label>
                        )}
                        <Toggle checked={showPeriodogram} onChange={setShowPeriodogram} label="Periodogram" />
                        <Toggle checked={showSchedule} onChange={setShowSchedule} label="Schedule overlay" />
                        {showSchedule && (
                            <Toggle
                                checked={showScheduleEditor}
                                onChange={setShowScheduleEditor}
                                label="Edit schedule"
                            />
                        )}
                        {showCircadian && tauHours === 24 && import.meta.env.DEV && (
                            <>
                                <Toggle checked={overlayEditMode} onChange={setOverlayEditMode} label="Edit overlay" />
                                {overlayEditMode && (
                                    <>
                                        <label className="flex items-center gap-2 text-sm text-gray-300">
                                            Window
                                            <input
                                                type="range"
                                                min={4}
                                                max={12}
                                                step={0.5}
                                                value={overlaySleepWindow}
                                                onChange={(e) => setOverlaySleepWindow(Number(e.target.value))}
                                                className="w-16 accent-cyan-500"
                                            />
                                            <span className="min-w-[3ch] font-mono text-xs text-slate-400">
                                                {overlaySleepWindow}h
                                            </span>
                                        </label>
                                        <span className="text-xs text-slate-400">
                                            {overlayControlPoints.length} pts
                                        </span>
                                        {overlayControlPoints.length > 0 && (
                                            <button
                                                onClick={() => setOverlayControlPoints([])}
                                                className="rounded bg-slate-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-slate-600"
                                            >
                                                Clear
                                            </button>
                                        )}
                                    </>
                                )}
                            </>
                        )}

                        {/* ── Divider ── */}
                        <div className="hidden h-6 border-l border-slate-700/50 lg:block" />
                        <div className="w-full border-t border-slate-700/50 lg:hidden" />

                        {/* ── Actogram ── */}
                        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                            Actogram
                        </span>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                            Color
                            <select
                                value={colorMode}
                                onChange={(e) => setColorMode(e.target.value as ColorMode)}
                                className="rounded bg-slate-700 px-2 py-0.5 text-sm text-gray-300"
                            >
                                <option value="stages">Sleep stages</option>
                                <option value="quality">Quality</option>
                            </select>
                        </label>
                        <label className="flex items-center gap-2 text-sm text-gray-300">
                            Row height
                            <input
                                type="range"
                                min={2}
                                max={maxRowHeight}
                                value={effectiveRowHeight}
                                onChange={(e) => setRowHeight(Number(e.target.value))}
                                className="w-24 accent-indigo-500"
                            />
                            <span className="min-w-[3ch] text-right font-mono text-xs text-slate-400">
                                {effectiveRowHeight}px
                            </span>
                        </label>
                        <RowWidthControl />

                        {/* ── Divider ── */}
                        <div className="hidden h-6 border-l border-slate-700/50 lg:block" />
                        <div className="w-full border-t border-slate-700/50 lg:hidden" />

                        {/* ── Forecast ── */}
                        <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                            Forecast
                        </span>
                        <div className="flex items-center gap-2 text-sm text-gray-300">
                            Days
                            <SegmentedControl
                                value={forecastDays}
                                options={[
                                    { key: 0, label: "Off" },
                                    { key: 2, label: "2" },
                                    { key: 7, label: "7" },
                                    { key: 30, label: "30" },
                                ]}
                                onChange={setForecastDays}
                                disabled={forecastDisabled}
                            />
                        </div>
                    </>
                )}

                {/* ── Collapse toggle ── */}
                <button
                    onClick={() => setCollapsed((c) => !c)}
                    className={`flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors ${collapsed ? "w-full justify-center" : "ml-auto"}`}
                    title={collapsed ? "Show controls" : "Hide controls"}
                >
                    {collapsed ? "Expand" : "Hide"}
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        className={`h-4 w-4 transition-transform ${collapsed ? "" : "rotate-180"}`}
                    >
                        <path
                            fillRule="evenodd"
                            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                            clipRule="evenodd"
                        />
                    </svg>
                </button>
            </div>
        </div>
    );
}
