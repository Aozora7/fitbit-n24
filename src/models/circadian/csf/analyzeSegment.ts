import type { SleepRecord } from "../../../api/types";
import type { CircadianDay } from "../types";
import type { CSFConfig, SegmentResult } from "./types";
import { DEFAULT_CONFIG, TAU_MIN, TAU_MAX } from "./types";
import { prepareAnchors } from "./anchors";
import { forwardPass, rtsSmoother, normalizeAngle, circularDiff } from "./filter";
import { smoothOutputPhase, correctEdge } from "./smoothing";

export function analyzeSegment(
    records: SleepRecord[],
    extraDays: number,
    globalFirstDateMs: number,
    config: CSFConfig = DEFAULT_CONFIG
): SegmentResult | null {
    if (records.length === 0) return null;

    const anchors = prepareAnchors(records, globalFirstDateMs);
    if (anchors.length < 2) return null;

    const firstAnchor = anchors[0]!;
    const lastAnchor = anchors[anchors.length - 1]!;
    const segFirstDay = firstAnchor.dayNumber;
    // Use last record's day (not last anchor's) so low-tier records that
    // aren't anchors still count as data days, not forecast days
    const lastRecordDay = Math.round(
        (new Date(records[records.length - 1]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
    );
    const segLastDay = Math.max(lastAnchor.dayNumber, lastRecordDay) + extraDays;
    const totalDays = segLastDay - segFirstDay;

    const forwardStates = forwardPass(anchors, segFirstDay, segLastDay, config);
    const smoothedStates = rtsSmoother(forwardStates, config);
    const outputStates = smoothOutputPhase(smoothedStates, 5, 8);
    const lastDataLocalDay = Math.max(lastAnchor.dayNumber, lastRecordDay) - segFirstDay;
    correctEdge(outputStates, anchors, segFirstDay, lastDataLocalDay, totalDays);

    const anchorByDay = new Map(anchors.map((a) => [a.dayNumber, a] as const));

    const smoothedDurations: number[] = [];
    const DURATION_SIGMA = 3;
    const DURATION_HALF_WINDOW = 5;
    for (let i = 0; i <= totalDays; i++) {
        let durSum = 0;
        let weightSum = 0;
        for (let j = Math.max(0, i - DURATION_HALF_WINDOW); j <= Math.min(totalDays, i + DURATION_HALF_WINDOW); j++) {
            const state = outputStates[j];
            const anchor = state ? anchorByDay.get(segFirstDay + j) : null;
            if (anchor) {
                const dist = Math.abs(j - i);
                const weight = Math.exp(-0.5 * (dist / DURATION_SIGMA) ** 2);
                durSum += weight * anchor.record.durationHours;
                weightSum += weight;
            }
        }
        smoothedDurations.push(weightSum > 0 ? durSum / weightSum : 8);
    }

    const days: CircadianDay[] = [];
    const residuals: number[] = [];

    const firstDate = new Date(globalFirstDateMs);

    for (let localD = 0; localD <= totalDays; localD++) {
        const globalD = segFirstDay + localD;
        const state = outputStates[localD];

        if (!state) continue;

        const dayDate = new Date(firstDate);
        dayDate.setDate(firstDate.getDate() + globalD);
        const dateStr =
            dayDate.getFullYear() +
            "-" +
            String(dayDate.getMonth() + 1).padStart(2, "0") +
            "-" +
            String(dayDate.getDate()).padStart(2, "0");

        const predictedMid = state.smoothedPhase;
        const localTau = state.smoothedTau;
        const localDrift = localTau - 24;

        const anchor = anchorByDay.get(globalD);
        const isForecast = globalD > segLastDay - extraDays;

        const halfDur = smoothedDurations[localD] ? smoothedDurations[localD]! / 2 : 4;

        let confScore: number;
        if (isForecast) {
            const distFromEdge = globalD - (segLastDay - extraDays);
            confScore = Math.max(0.1, 0.5 * Math.exp(-0.1 * distFromEdge));
        } else {
            const density = Math.min(1, 1 / Math.max(state.smoothedPhaseVar, 0.1));
            confScore = Math.min(1, density * (1 - Math.min(1, state.smoothedPhaseVar / 2)));
        }

        const normalizedMid = normalizeAngle(predictedMid);

        days.push({
            date: dateStr,
            nightStartHour: normalizedMid - halfDur,
            nightEndHour: normalizedMid + halfDur,
            confidenceScore: confScore,
            confidence: confScore >= 0.6 ? "high" : confScore >= 0.3 ? "medium" : "low",
            localTau: Math.max(TAU_MIN, Math.min(TAU_MAX, localTau)),
            localDrift: Math.max(-1.5, Math.min(3.0, localDrift)),
            anchorSleep: anchor?.record,
            isForecast,
            isGap: false,
        });

        if (!isForecast && anchor) {
            const residual = Math.abs(circularDiff(anchor.midpointHour, predictedMid));
            residuals.push(residual);
        }
    }

    return {
        days,
        states: smoothedStates,
        anchors,
        anchorCount: anchors.length,
        residuals,
        segFirstDay,
        segLastDay: segLastDay - extraDays,
    };
}
