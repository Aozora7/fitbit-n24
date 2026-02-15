// Circadian period estimation — orchestrator and public API
import type { SleepRecord } from "../../api/types";
import type { CircadianAnalysis } from "./types";
import { splitIntoSegments } from "./anchors";
import { analyzeSegment } from "./analyzeSegment";
import { mergeSegmentResults } from "./mergeSegments";

// ─── Public type re-exports ────────────────────────────────────────

export type { CircadianDay, AnchorPoint, CircadianAnalysis } from "./types";

// ─── Main analysis function ────────────────────────────────────────

/**
 * Orchestrator: splits records into independent segments at data gaps,
 * analyzes each segment with the full pipeline, and merges results.
 * @param extraDays - Number of days to forecast beyond the data range
 */
export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): CircadianAnalysis {
    const empty: CircadianAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
        anchors: [],
        medianResidualHours: 0,
        anchorCount: 0,
        anchorTierCounts: { A: 0, B: 0, C: 0 },
        tau: 24,
        dailyDrift: 0,
        rSquared: 0,
    };

    if (records.length === 0) return empty;

    // Sort all records and compute global epoch
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const globalFirstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    // Split into independent segments at data gaps > GAP_THRESHOLD_DAYS
    const recordSegments = splitIntoSegments(sorted);

    // Analyze each segment independently
    const segmentResults: (ReturnType<typeof analyzeSegment> & {})[] = [];
    for (let i = 0; i < recordSegments.length; i++) {
        const isLast = i === recordSegments.length - 1;
        const result = analyzeSegment(recordSegments[i]!, isLast ? extraDays : 0, globalFirstDateMs);
        if (result) segmentResults.push(result);
    }

    if (segmentResults.length === 0) return empty;

    return mergeSegmentResults(segmentResults, globalFirstDateMs);
}

// ─── Test internals barrel ─────────────────────────────────────────

import {
    classifyAnchor,
    sleepMidpointHour,
    computeMedianSpacing,
    splitIntoSegments as _splitIntoSegments,
} from "./anchors";
import {
    localPairwiseUnwrap,
    findSeedRegion,
    expandFromRegion,
    snapToNeighbors,
    unwrapAnchorsFromSeed,
} from "./unwrap";
import { weightedLinearRegression, robustWeightedRegression, gaussian, evaluateWindow } from "./regression";
import { GAP_THRESHOLD_DAYS } from "./types";

/** @internal Exported for testing only. */
export const _internals = {
    classifyAnchor,
    sleepMidpointHour,
    localPairwiseUnwrap,
    findSeedRegion,
    weightedLinearRegression,
    robustWeightedRegression,
    gaussian,
    evaluateWindow,
    computeMedianSpacing,
    expandFromRegion,
    snapToNeighbors,
    unwrapAnchorsFromSeed,
    GAP_THRESHOLD_DAYS,
    splitIntoSegments: _splitIntoSegments,
};
