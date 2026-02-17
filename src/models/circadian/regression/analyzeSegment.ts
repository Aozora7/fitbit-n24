// Per-segment analysis pipeline: anchor building, unwrap, outlier rejection, sliding window, smoothing
import type { SleepRecord } from "../../../api/types";
import type { CircadianDay } from "../types";
import type { Anchor, SegmentResult } from "./types";
import { WINDOW_HALF, MIN_ANCHORS_PER_WINDOW, OUTLIER_THRESHOLD_HOURS, REGULARIZATION_HALF } from "./types";
import { evaluateWindow, evaluateWindowExpanding } from "./regression";
import { computeAnchorWeight, sleepMidpointHour, computeMedianSpacing } from "./anchors";
import { unwrapAnchorsFromSeed } from "./unwrap";
import { smoothOverlay } from "./smoothing";

export function analyzeSegment(
    records: SleepRecord[],
    extraDays: number,
    globalFirstDateMs: number
): SegmentResult | null {
    if (records.length === 0) return null;

    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

    let anchors: Anchor[] = [];
    for (const record of sorted) {
        const weight = computeAnchorWeight(record);
        if (weight === null) continue;
        anchors.push({
            dayNumber: Math.round(
                (new Date(record.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
            ),
            midpointHour: sleepMidpointHour(record, globalFirstDateMs),
            weight,
            record,
            date: record.dateOfSleep,
        });
    }

    if (anchors.length < 2) return null;

    unwrapAnchorsFromSeed(anchors);

    const globalFit = evaluateWindow(
        anchors,
        anchors[Math.floor(anchors.length / 2)]!.dayNumber,
        anchors[anchors.length - 1]!.dayNumber
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

    const segFirstDay = Math.round(
        (new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
    );
    const segLastDay = Math.max(
        anchors[anchors.length - 1]!.dayNumber,
        Math.round(
            (new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
        )
    );
    const localDataDays = segLastDay - segFirstDay;
    const localTotalDays = localDataDays + extraDays;

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

    const rawPredictedMid: number[] = [];
    const rawConfScore: number[] = [];
    const rawIsForecast: boolean[] = [];
    const rawSlopeConf: number[] = [];
    const rawHalfDur: number[] = [];

    const edgeResult = evaluateWindowExpanding(anchors, segLastDay);

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

        const regionalFit = evaluateWindow(anchors, globalD, REGULARIZATION_HALF);
        const useRegional =
            regionalFit.pointsUsed >= MIN_ANCHORS_PER_WINDOW && regionalFit.slope >= -0.5 && regionalFit.slope <= 2.0;
        const fallbackSlope = useRegional ? regionalFit.slope : globalFit.slope;

        const slopeDiff = Math.abs(result.slope - fallbackSlope);
        const REGIME_CHANGE_THRESHOLD = 0.3;
        if (
            slopeDiff > REGIME_CHANGE_THRESHOLD &&
            result.pointsUsed >= MIN_ANCHORS_PER_WINDOW &&
            result.residualMAD < 2.0
        ) {
            const boost = Math.min(0.4, (slopeDiff - REGIME_CHANGE_THRESHOLD) * 0.5);
            slopeConf = Math.min(1, slopeConf + boost);
        }

        let regularizedSlope = slopeConf * result.slope + (1 - slopeConf) * fallbackSlope;

        if (regularizedSlope > 2.0 || regularizedSlope < -0.5) {
            regularizedSlope = fallbackSlope;
        }

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
            date: a.date,
        })),
        anchorCount: anchors.length,
        residuals: allResiduals,
        segFirstDay,
        segLastDay,
    };
}
