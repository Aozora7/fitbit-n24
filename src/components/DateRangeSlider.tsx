import { useState, useCallback, useRef, useEffect } from "react";
import { useAppContext, usePersistedState } from "../AppContext";

/**
 * Dual-thumb range slider for date filtering.
 * Uses two native range inputs overlaid on each other.
 * Commits values only on pointerup to avoid expensive re-renders.
 */
export default function DateRangeSlider() {
    const { totalDays, filterStart, filterEnd, handleFilterChange, firstDateStr, data } = useAppContext();
    const disabled = data.fetching;
    const startDay = filterStart;
    const endDay = filterEnd || totalDays;

    // Local state for dragging (so we can show preview without committing)
    const [localStart, setLocalStart] = useState(startDay);
    const [localEnd, setLocalEnd] = useState(endDay);
    const draggingRef = useRef(false);

    // Persisted preset: number of days (30/90/180/365), 0 = All, null = custom/no preset
    const [savedPreset, setSavedPreset] = usePersistedState<number | null>("viz.datePreset", null);

    // Sync local state when committed values change externally
    useEffect(() => {
        if (!draggingRef.current && savedPreset === null) {
            setLocalStart(startDay);
            setLocalEnd(endDay);
        }
    }, [startDay, endDay, savedPreset]);

    const handleStartChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = Number(e.target.value);
            setLocalStart(Math.min(val, localEnd - 1));
            draggingRef.current = true;
        },
        [localEnd]
    );

    const handleEndChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const val = Number(e.target.value);
            setLocalEnd(Math.max(val, localStart + 1));
            draggingRef.current = true;
        },
        [localStart]
    );

    const commitValues = useCallback(() => {
        draggingRef.current = false;
        handleFilterChange(localStart, localEnd);
        setSavedPreset(null);
    }, [localStart, localEnd, handleFilterChange, setSavedPreset]);

    // Compute the date label for a given day index
    const dayLabel = useCallback(
        (dayIdx: number): string => {
            if (!firstDateStr) return "";
            const d = new Date(firstDateStr + "T00:00:00");
            d.setDate(d.getDate() + dayIdx);
            return (
                d.getFullYear() +
                "-" +
                String(d.getMonth() + 1).padStart(2, "0") +
                "-" +
                String(d.getDate()).padStart(2, "0")
            );
        },
        [firstDateStr]
    );

    // Calculate year marks (day indices where each year starts)
    const yearMarks = useCallback((): Array<{ dayIdx: number; year: number }> => {
        if (!firstDateStr || totalDays <= 1) return [];

        const marks: Array<{ dayIdx: number; year: number }> = [];
        const firstDate = new Date(firstDateStr + "T00:00:00");

        // Find all year boundaries within the range
        let currentDate = new Date(firstDate);
        for (let dayIdx = 0; dayIdx <= totalDays; dayIdx++) {
            currentDate.setTime(firstDate.getTime());
            currentDate.setDate(firstDate.getDate() + dayIdx);
            if (currentDate.getMonth() === 0 && currentDate.getDate() === 1) {
                marks.push({ dayIdx, year: currentDate.getFullYear() });
            }
        }

        return marks;
    }, [firstDateStr, totalDays]);

    const presets = [
        { days: 30, label: "30d" },
        { days: 60, label: "60d" },
        { days: 90, label: "90d" },
        { days: 180, label: "180d" },
        { days: 365, label: "1y" },
    ];

    const applyPreset = useCallback(
        (days: number) => {
            const start = Math.max(0, totalDays - days);
            setLocalStart(start);
            setLocalEnd(totalDays);
            handleFilterChange(start, totalDays);
            setSavedPreset(days);
        },
        [totalDays, handleFilterChange, setSavedPreset]
    );

    const applyAll = useCallback(() => {
        setLocalStart(0);
        setLocalEnd(totalDays);
        handleFilterChange(0, totalDays);
        setSavedPreset(0);
    }, [totalDays, handleFilterChange, setSavedPreset]);

    // Reapply saved preset when totalDays becomes available (e.g. on reload/data fetch)
    const presetAppliedRef = useRef(false);
    useEffect(() => {
        if (totalDays > 1 && savedPreset !== null && !presetAppliedRef.current) {
            presetAppliedRef.current = true;
            if (savedPreset === 0) {
                handleFilterChange(0, totalDays);
            } else {
                const start = Math.max(0, totalDays - savedPreset);
                setLocalStart(start);
                setLocalEnd(totalDays);
                handleFilterChange(start, totalDays);
            }
        }
    }, [totalDays, savedPreset, handleFilterChange]);

    if (totalDays <= 1) return null;

    // Fill percentage for the active range highlight
    const startPct = (localStart / totalDays) * 100;
    const endPct = (localEnd / totalDays) * 100;

    const isFiltered = localStart > 0 || localEnd < totalDays;

    // Check which preset is active (end at totalDays and start matches a preset)
    const activePreset =
        localEnd === totalDays
            ? (presets.find((p) => localStart === Math.max(0, totalDays - p.days))?.days ??
              (localStart === 0 ? 0 : null)) // 0 means "All"
            : null;

    return (
        <div className="mt-2">
            {/* Date labels + preset buttons */}
            <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
                <span className={isFiltered ? "text-blue-400" : ""}>{dayLabel(localStart)}</span>
                <div className="flex gap-1">
                    {presets
                        .filter((p) => p.days < totalDays)
                        .map((p) => (
                            <button
                                key={p.days}
                                onClick={() => applyPreset(p.days)}
                                disabled={disabled}
                                className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                                    activePreset === p.days
                                        ? "bg-blue-600/30 text-blue-400"
                                        : "text-gray-500 hover:text-gray-300"
                                }`}
                            >
                                {p.label}
                            </button>
                        ))}
                    <button
                        onClick={applyAll}
                        disabled={disabled}
                        className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                            activePreset === 0 ? "bg-blue-600/30 text-blue-400" : "text-gray-500 hover:text-gray-300"
                        }`}
                    >
                        All
                    </button>
                </div>
                <span className={isFiltered ? "text-blue-400" : ""}>{dayLabel(localEnd)}</span>
            </div>

            {/* Slider track with two range inputs */}
            <div className="relative h-3">
                {/* Background track */}
                <div className="absolute top-2 right-0 left-0 h-1 rounded bg-gray-700" />

                {/* Active range highlight */}
                <div
                    className="absolute top-2 h-1 rounded bg-blue-600/50"
                    style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }}
                />

                {/* Start thumb */}
                <input
                    type="range"
                    min={0}
                    max={totalDays}
                    step={1}
                    value={localStart}
                    onChange={handleStartChange}
                    onMouseUp={commitValues}
                    onTouchEnd={commitValues}
                    disabled={disabled}
                    className="range-thumb pointer-events-none absolute top-0 z-10 h-5 w-full appearance-none bg-transparent"
                    style={{ pointerEvents: "none" }}
                />

                {/* End thumb */}
                <input
                    type="range"
                    min={0}
                    max={totalDays}
                    step={1}
                    value={localEnd}
                    onChange={handleEndChange}
                    onMouseUp={commitValues}
                    onTouchEnd={commitValues}
                    disabled={disabled}
                    className="range-thumb pointer-events-none absolute top-0 z-20 h-5 w-full appearance-none bg-transparent"
                    style={{ pointerEvents: "none" }}
                />
            </div>

            {/* Year marks – padded to match range input thumb offset */}
            <div className="relative mt-1 h-2" style={{ marginLeft: 8, marginRight: 8 }}>
                {yearMarks().map((mark) => {
                    const position = (mark.dayIdx / totalDays) * 100;
                    return (
                        <div key={mark.dayIdx} className="absolute" style={{ left: `${position}%` }}>
                            {/* Tick mark */}
                            <div className="h-1 w-px bg-gray-600" />
                            {/* Year label */}
                            <div className="text-[10px] text-gray-500" style={{ transform: "translateX(-50%)" }}>
                                {mark.year}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
