// Kalman filter circadian analysis — public API and algorithm registration
import type { SleepRecord } from "../../../api/types";
import type { KalmanAnalysis } from "./types";
import { splitIntoSegments } from "../segments";
import { analyzeSegment } from "./analyzeSegment";
import { mergeSegmentResults, ALGORITHM_ID } from "./mergeSegments";
import { getFirstDateMs } from "./observations";

export { ALGORITHM_ID };
export type { KalmanAnalysis } from "./types";

export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): KalmanAnalysis {
    if (records.length === 0) {
        return mergeSegmentResults([], 0);
    }

    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const globalFirstDateMs = getFirstDateMs(sorted);
    const segments = splitIntoSegments(sorted);

    const results = segments
        .map((seg) => analyzeSegment(seg, extraDays, globalFirstDateMs))
        .filter((r): r is NonNullable<typeof r> => r !== null);

    return mergeSegmentResults(results, globalFirstDateMs);
}

// Expose internals for unit testing (tree-shaken from production builds)
export const _internals = {
    analyzeSegment,
    mergeSegmentResults,
    ALGORITHM_ID,
};
