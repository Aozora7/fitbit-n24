import { useAppContext } from "../AppContext";
import type { ColorMode } from "./Actogram/useActogramRenderer";

export default function VisualizationControls() {
    const {
        doublePlot,
        setDoublePlot,
        showCircadian,
        setShowCircadian,
        showPeriodogram,
        setShowPeriodogram,
        colorMode,
        setColorMode,
        tauHours,
        setTauHours,
        circadianAnalysis,
        effectiveRowHeight,
        maxRowHeight,
        setRowHeight,
        forecastDays,
        setForecastDays
    } = useAppContext();

    return (
        <div className="mx-auto mb-4 flex flex-wrap max-w-5xl gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={doublePlot} onChange={e => setDoublePlot(e.target.checked)} className="rounded" />
                Double plot
            </label>

            <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={showCircadian} onChange={e => setShowCircadian(e.target.checked)} className="rounded" />
                Show circadian overlay
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={showPeriodogram} onChange={e => setShowPeriodogram(e.target.checked)} className="rounded" />
                Periodogram
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
                Color:
                <select
                    value={colorMode}
                    onChange={e => setColorMode(e.target.value as ColorMode)}
                    className="rounded bg-gray-700 px-2 py-0.5 text-sm text-gray-300"
                >
                    <option value="stages">Sleep stages</option>
                    <option value="quality">Quality</option>
                </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
                Row height:
                <input
                    type="range"
                    min={2}
                    max={maxRowHeight}
                    value={effectiveRowHeight}
                    onChange={e => setRowHeight(Number(e.target.value))}
                    className="w-24"
                />
                <span className="font-mono text-xs">{effectiveRowHeight}px</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
                Row width (τ):
                <input
                    type="number"
                    min={23}
                    max={26}
                    step={0.01}
                    value={tauHours}
                    onChange={e => {
                        const v = parseFloat(e.target.value);
                        if (!isNaN(v) && v >= 23 && v <= 26) setTauHours(v);
                    }}
                    className="w-20 rounded bg-gray-700 px-2 py-0.5 text-sm text-gray-300 font-mono"
                />
                <button onClick={() => setTauHours(24)} className="rounded h-6 bg-gray-600 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-500">
                    24h
                </button>
                {circadianAnalysis.globalTau !== 24 && (
                    <button
                        onClick={() => setTauHours(parseFloat(circadianAnalysis.globalTau.toFixed(2)))}
                        className="rounded h-6 bg-gray-600 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-500"
                    >
                        Use τ={circadianAnalysis.globalTau.toFixed(2)}
                    </button>
                )}
            </label>
            <div className="flex items-center gap-2 text-sm text-gray-300">
                Forecast days:
                {[1, 7, 30].map(v => (
                    <button
                        key={v}
                        onClick={() => setForecastDays(v)}
                        className={`rounded rounded-base  h-6 px-2 py-0.5 text-xs ${
                            forecastDays === v ? "bg-indigo-600 text-white" : "bg-gray-600 text-gray-300 hover:bg-gray-500"
                        }`}
                    >
                        {v}
                    </button>
                ))}
            </div>
        </div>
    );
}
