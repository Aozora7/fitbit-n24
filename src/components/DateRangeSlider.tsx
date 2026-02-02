import { useState, useCallback, useRef, useEffect } from "react";
import { useAppContext } from "../AppContext";

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

    // Sync local state when committed values change externally
    useEffect(() => {
        if (!draggingRef.current) {
            setLocalStart(startDay);
            setLocalEnd(endDay);
        }
    }, [startDay, endDay]);

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
    }, [localStart, localEnd, handleFilterChange]);

    // Compute the date label for a given day index
    const dayLabel = useCallback(
        (dayIdx: number): string => {
            if (!firstDateStr) return "";
            const d = new Date(firstDateStr + "T00:00:00");
            d.setDate(d.getDate() + dayIdx);
            return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
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
            currentDate.setTime(firstDate.getTime() + dayIdx * 86400000);
            if (currentDate.getMonth() === 0 && currentDate.getDate() === 1) {
                marks.push({ dayIdx, year: currentDate.getFullYear() });
            }
        }

        return marks;
    }, [firstDateStr, totalDays]);

    if (totalDays <= 1) return null;

    // Fill percentage for the active range highlight
    const startPct = (localStart / totalDays) * 100;
    const endPct = (localEnd / totalDays) * 100;

    const isFiltered = localStart > 0 || localEnd < totalDays;

    return (
        <div className="mt-2">
            {/* Date labels */}
            <div className="mb-1 flex items-center justify-between text-xs text-gray-400">
                <span className={isFiltered ? "text-blue-400" : ""}>{dayLabel(localStart)}</span>
                {isFiltered && (
                    <button
                        onClick={() => {
                            setLocalStart(0);
                            setLocalEnd(totalDays);
                            handleFilterChange(0, totalDays);
                        }}
                        className="text-xs text-gray-500 hover:text-gray-300"
                        disabled={disabled}
                    >
                        Reset filter
                    </button>
                )}
                <span className={isFiltered ? "text-blue-400" : ""}>{dayLabel(localEnd)}</span>
            </div>

            {/* Slider track with two range inputs */}
            <div className="relative h-3">
                {/* Background track */}
                <div className="absolute top-2 right-0 left-0 h-1 rounded bg-gray-700" />

                {/* Active range highlight */}
                <div className="absolute top-2 h-1 rounded bg-blue-600/50" style={{ left: `${startPct}%`, width: `${endPct - startPct}%` }} />

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
                {yearMarks().map(mark => {
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
