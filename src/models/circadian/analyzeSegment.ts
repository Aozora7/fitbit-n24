// Per-segment analysis pipeline: anchor building, unwrap, outlier rejection, sliding window, smoothing
import type { SleepRecord } from "../../api/types";
import type { Anchor, CircadianDay, SegmentResult } from "./types";
import { WINDOW_HALF, MIN_ANCHORS_PER_WINDOW, OUTLIER_THRESHOLD_HOURS, REGULARIZATION_HALF } from "./types";
import { evaluateWindow, evaluateWindowExpanding } from "./regression";
import { classifyAnchor, sleepMidpointHour, computeMedianSpacing } from "./anchors";
import { unwrapAnchorsFromSeed } from "./unwrap";
import { smoothOverlay } from "./smoothing";

/**
 * Analyze a single contiguous segment of sleep records.
 * @param records - Records within this segment (no gaps > GAP_THRESHOLD_DAYS)
 * @param extraDays - Forecast days to append (only for the last segment)
 * @param globalFirstDateMs - Epoch of the first record across all segments (for consistent day numbering)
 */
export function analyzeSegment(
    records: SleepRecord[],
    extraDays: number,
    globalFirstDateMs: number
): SegmentResult | null {
    if (records.length === 0) return null;

    // Step 1: Classify all records
    const candidates = records.map((r) => classifyAnchor(r)).filter((c): c is NonNullable<typeof c> => c !== null);

    if (candidates.length < 2) return null;

    const tierCounts = { A: 0, B: 0, C: 0 };
    for (const c of candidates) tierCounts[c.tier]++;

    // Step 2: Check if Tier C needed (max A+B gap > 14 days)
    const abDates = [...new Set(candidates.filter((c) => c.tier !== "C").map((c) => c.record.dateOfSleep))].sort();

    let maxGapAB = 0;
    for (let i = 1; i < abDates.length; i++) {
        const gap = Math.round(
            (new Date(abDates[i]! + "T00:00:00").getTime() - new Date(abDates[i - 1]! + "T00:00:00").getTime()) /
                86_400_000
        );
        maxGapAB = Math.max(maxGapAB, gap);
    }

    const activeCandidates = maxGapAB > 14 ? candidates : candidates.filter((c) => c.tier !== "C");

    // Step 3: Build anchors sorted by date (using global epoch for day numbers)
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const activeIds = new Set(activeCandidates.map((c) => c.record.logId));
    const candMap = new Map(activeCandidates.map((c) => [c.record.logId, c]));

    let anchors: Anchor[] = [];
    for (const record of sorted) {
        if (!activeIds.has(record.logId)) continue;
        const c = candMap.get(record.logId)!;
        anchors.push({
            dayNumber: Math.round(
                (new Date(record.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
            ),
            midpointHour: sleepMidpointHour(record, globalFirstDateMs),
            weight: c.weight,
            tier: c.tier,
            record,
            date: record.dateOfSleep,
        });
    }

    if (anchors.length < 2) return null;

    // Step 4: Unwrap
    unwrapAnchorsFromSeed(anchors);

    // Step 5: Outlier detection — global preliminary fit
    const globalFit = evaluateWindow(
        anchors,
        anchors[Math.floor(anchors.length / 2)]!.dayNumber,
        anchors[anchors.length - 1]!.dayNumber // very wide
    );

    const outliers = new Set<number>();
    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i]!;
        const pred = globalFit.slope * a.dayNumber + globalFit.intercept;
        if (Math.abs(a.midpointHour - pred) > OUTLIER_THRESHOLD_HOURS) {
            outliers.add(i);
        }
    }

    if (outliers.size > 0 && outliers.size < anchors.length * 0.15) {
        anchors = anchors.filter((_, i) => !outliers.has(i));
        unwrapAnchorsFromSeed(anchors);
    }

    // Step 6: Per-day sliding window
    const segFirstDay = Math.round(
        (new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
    );
    const segLastDay = Math.max(
        anchors[anchors.length - 1]!.dayNumber,
        Math.round(
            (new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
        )
    );
    const localDataDays = segLastDay - segFirstDay; // local index of last data day
    const localTotalDays = localDataDays + extraDays;

    // Best anchor per date for anchorSleep field
    const bestAnchorByDate = new Map<string, Anchor>();
    for (const a of anchors) {
        const existing = bestAnchorByDate.get(a.date);
        if (!existing || a.weight > existing.weight) {
            bestAnchorByDate.set(a.date, a);
        }
    }

    const medianSpacing = computeMedianSpacing(anchors);
    const days: CircadianDay[] = [];
    const allResiduals: number[] = [];

    // Parallel arrays for post-hoc smoothing (local 0-based indexing)
    const rawPredictedMid: number[] = [];
    const rawConfScore: number[] = [];
    const rawIsForecast: boolean[] = [];
    const rawSlopeConf: number[] = [];
    const rawHalfDur: number[] = [];

    // Compute edge fit for forecast extrapolation: freeze the regression
    // from the last data day so forecast days extrapolate smoothly instead
    // of re-evaluating a window that drifts away from real data.
    const edgeResult = evaluateWindowExpanding(anchors, segLastDay);

    // Base confidence for the edge fit (used to compute decaying forecast confidence)
    const edgeExpected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
    const edgeBaseConf =
        0.4 * Math.min(1, edgeResult.pointsUsed / edgeExpected) +
        0.3 * edgeResult.avgQuality +
        0.3 * (1 - Math.min(1, edgeResult.residualMAD / 3));

    const firstDate = new Date(globalFirstDateMs);
    for (let localD = 0; localD <= localTotalDays; localD++) {
        const globalD = segFirstDay + localD;
        const dayDate = new Date(firstDate);
        dayDate.setDate(firstDate.getDate() + globalD);
        const dateStr =
            dayDate.getFullYear() +
            "-" +
            String(dayDate.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(dayDate.getDate()).padStart(2, "0");

        const isForecast = localD > localDataDays;
        let result;

        if (isForecast) {
            result = edgeResult;
        } else {
            result = evaluateWindowExpanding(anchors, globalD);
        }

        const expectedPts = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
        let slopeConf = Math.min(1, result.pointsUsed / expectedPts) * (1 - Math.min(1, result.residualMAD / 4));

        // Regime change detection: when local slope differs significantly from
        // regional slope, trust the local window more to prevent blending across
        // regime boundaries (e.g., short entrained periods surrounded by N24).
        const regionalFit = evaluateWindow(anchors, globalD, REGULARIZATION_HALF);
        const useRegional =
            regionalFit.pointsUsed >= MIN_ANCHORS_PER_WINDOW && regionalFit.slope >= -0.5 && regionalFit.slope <= 2.0;
        const fallbackSlope = useRegional ? regionalFit.slope : globalFit.slope;

        // Detect potential regime change: if local and regional slopes differ by > 0.3h/day
        // and local window has sufficient anchors, increase confidence in local slope
        const slopeDiff = Math.abs(result.slope - fallbackSlope);
        const REGIME_CHANGE_THRESHOLD = 0.3; // 0.3h/day ≈ τ difference of 0.3h
        if (
            slopeDiff > REGIME_CHANGE_THRESHOLD &&
            result.pointsUsed >= MIN_ANCHORS_PER_WINDOW &&
            result.residualMAD < 2.0
        ) {
            // Boost local confidence to prevent blending across regime boundaries
            // Scale boost by how different the slopes are (more different = more boost)
            const boost = Math.min(0.4, (slopeDiff - REGIME_CHANGE_THRESHOLD) * 0.5);
            slopeConf = Math.min(1, slopeConf + boost);
        }

        let regularizedSlope = slopeConf * result.slope + (1 - slopeConf) * fallbackSlope;

        // Safety cap: extreme slopes (>2.0 h/day = tau > 26h) are almost always
        // estimation errors during fragmentation. Fall back to regional slope.
        if (regularizedSlope > 2.0 || regularizedSlope < -0.5) {
            regularizedSlope = fallbackSlope;
        }

        // Clamp to non-negative: the circadian clock doesn't run backward (tau < 24h).
        // Slightly negative regularized slopes arise from noisy fragmented data pulling
        // the local regression negative even after regularization toward regional slope.
        regularizedSlope = Math.max(0, regularizedSlope);

        const localTau = 24 + regularizedSlope;

        const centroidPred = result.slope * result.weightedMeanX + result.intercept;
        const predictedMid = centroidPred + regularizedSlope * (globalD - result.weightedMeanX);

        const halfDur = result.avgDuration / 2;

        let confScore: number;
        if (isForecast) {
            const distFromEdge = localD - localDataDays;
            confScore = edgeBaseConf * Math.exp(-0.1 * distFromEdge);
        } else {
            const expected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
            const density = Math.min(1, result.pointsUsed / expected);
            const quality = result.avgQuality;
            const spread = 1 - Math.min(1, result.residualMAD / 3);
            confScore = 0.4 * density + 0.3 * quality + 0.3 * spread;
        }

        rawPredictedMid.push(predictedMid);
        rawSlopeConf.push(slopeConf);
        rawConfScore.push(confScore);
        rawIsForecast.push(isForecast);
        rawHalfDur.push(halfDur);

        const normalizedMid = ((predictedMid % 24) + 24) % 24;

        days.push({
            date: dateStr,
            nightStartHour: normalizedMid - halfDur,
            nightEndHour: normalizedMid + halfDur,
            confidenceScore: confScore,
            confidence: confScore >= 0.6 ? "high" : confScore >= 0.3 ? "medium" : "low",
            localTau,
            localDrift: regularizedSlope,
            anchorSleep: bestAnchorByDate.get(dateStr)?.record,
            isForecast,
            isGap: false,
        });

        if (!isForecast) {
            for (const a of anchors) {
                if (Math.abs(a.dayNumber - globalD) < 0.5) {
                    allResiduals.push(Math.abs(a.midpointHour - predictedMid));
                }
            }
        }
    }

    // Post-hoc smoothing (3 passes + forecast recomputation)
    smoothOverlay({
        anchors,
        days,
        rawPredictedMid,
        rawConfScore,
        rawIsForecast,
        rawSlopeConf,
        rawHalfDur,
        segFirstDay,
        localDataDays,
        localTotalDays,
        edgeResult,
        medianSpacing,
        globalFit,
        extraDays,
    });

    return {
        days,
        anchors: anchors.map((a) => ({
            dayNumber: a.dayNumber,
            midpointHour: a.midpointHour,
            weight: a.weight,
            tier: a.tier,
            date: a.date,
        })),
        tierCounts,
        anchorCount: anchors.length,
        residuals: allResiduals,
        segFirstDay,
        segLastDay,
    };
}
