/**
 * Weighted Regression Circadian Period Estimation Algorithm (regression-v1)
 *
 * Module structure:
 *   index.ts         - Algorithm entry point: analyzeCircadian(), _internals barrel
 *   types.ts         - Types: RegressionAnalysis, Anchor, AnchorPoint, constants
 *   anchors.ts       - Anchor weight computation, midpoint calculation
 *   regression.ts    - Weighted/robust regression (IRLS+Tukey), Gaussian kernel
 *   unwrap.ts        - Seed-based phase unwrapping with branch resolution
 *   smoothing.ts     - 3-pass post-hoc overlay smoothing + forecast re-anchoring
 *   analyzeSegment.ts - Per-segment analysis pipeline
 *   mergeSegments.ts - Merge independently-analyzed segments
 *   __tests__/       - Unit tests for internals
 */
import type { SleepRecord } from "../../../api/types";
import type { RegressionAnalysis } from "./types";
import { splitIntoSegments } from "../segments";
import { analyzeSegment } from "./analyzeSegment";
import { mergeSegmentResults, ALGORITHM_ID } from "./mergeSegments";

export { ALGORITHM_ID };

export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): RegressionAnalysis {
    const empty: RegressionAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
        algorithmId: ALGORITHM_ID,
        tau: 24,
        dailyDrift: 0,
        rSquared: 0,
        anchors: [],
        medianResidualHours: 0,
        anchorCount: 0,
    };

    if (records.length === 0) return empty;

    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const globalFirstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    const recordSegments = splitIntoSegments(sorted);

    const segmentResults: (ReturnType<typeof analyzeSegment> & {})[] = [];
    for (let i = 0; i < recordSegments.length; i++) {
        const isLast = i === recordSegments.length - 1;
        const result = analyzeSegment(recordSegments[i]!, isLast ? extraDays : 0, globalFirstDateMs);
        if (result) segmentResults.push(result);
    }

    if (segmentResults.length === 0) return empty;

    return mergeSegmentResults(segmentResults, globalFirstDateMs);
}

import { computeAnchorWeight, sleepMidpointHour, computeMedianSpacing } from "./anchors";
import {
    localPairwiseUnwrap,
    findSeedRegion,
    expandFromRegion,
    snapToNeighbors,
    unwrapAnchorsFromSeed,
} from "./unwrap";
import { weightedLinearRegression, robustWeightedRegression, gaussian, evaluateWindow } from "./regression";

export const _internals = {
    computeAnchorWeight,
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
};
