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
        effectiveRowHeight,
        maxRowHeight,
        setRowHeight
    } = useAppContext();

    return (
        <div className="mx-auto mb-4 flex flex-wrap max-w-5xl gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={doublePlot} onChange={e => setDoublePlot(e.target.checked)} className="rounded" />
                Double plot (48h)
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
        </div>
    );
}
