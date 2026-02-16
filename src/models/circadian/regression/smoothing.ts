// Post-hoc overlay smoothing: 3-pass jump correction and forecast re-anchoring
import type { CircadianDay } from "../types";
import type { Anchor } from "./types";
import type { WindowResult } from "./regression";
import {
    WINDOW_HALF,
    MIN_ANCHORS_PER_WINDOW,
    REGULARIZATION_HALF,
    SMOOTH_HALF,
    SMOOTH_SIGMA,
    SMOOTH_JUMP_THRESH,
} from "./types";
import { gaussian, evaluateWindow } from "./regression";

export interface SmoothingContext {
    anchors: Anchor[];
    days: CircadianDay[];
    rawPredictedMid: number[];
    rawConfScore: number[];
    rawIsForecast: boolean[];
    rawSlopeConf: number[];
    rawHalfDur: number[];
    segFirstDay: number;
    localDataDays: number;
    localTotalDays: number;
    edgeResult: WindowResult;
    medianSpacing: number;
    globalFit: WindowResult;
    extraDays: number;
}

export function smoothOverlay(ctx: SmoothingContext): void {
    const {
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
    } = ctx;

    for (let i = 1; i <= localTotalDays; i++) {
        if (rawIsForecast[i] || rawIsForecast[i - 1]) continue;
        let curr = rawPredictedMid[i]!;
        const prev = rawPredictedMid[i - 1]!;
        while (curr - prev > 12) curr -= 24;
        while (prev - curr > 12) curr += 24;
        rawPredictedMid[i] = curr;
    }

    const smoothGlobalFit = evaluateWindow(
        anchors,
        anchors[Math.floor(anchors.length / 2)]!.dayNumber,
        anchors[anchors.length - 1]!.dayNumber
    );

    const SLOPE_CONF_THRESH = 0.4;
    const needsAnchorSmooth: boolean[] = new Array(localTotalDays + 1).fill(false);
    for (let i = 0; i <= localTotalDays; i++) {
        if (rawIsForecast[i]) continue;
        if (rawSlopeConf[i]! < SLOPE_CONF_THRESH) needsAnchorSmooth[i] = true;
    }

    const SMOOTH_MARGIN = 5;
    const distToCore: number[] = new Array(localTotalDays + 1).fill(Infinity);
    for (let i = 0; i <= localTotalDays; i++) {
        if (needsAnchorSmooth[i]) distToCore[i] = 0;
    }
    for (let i = 1; i <= localTotalDays; i++) {
        if (distToCore[i - 1]! + 1 < distToCore[i]!) distToCore[i] = distToCore[i - 1]! + 1;
    }
    for (let i = localTotalDays - 1; i >= 0; i--) {
        if (distToCore[i + 1]! + 1 < distToCore[i]!) distToCore[i] = distToCore[i + 1]! + 1;
    }
    for (let i = 0; i <= localTotalDays; i++) {
        if (!rawIsForecast[i] && distToCore[i]! <= SMOOTH_MARGIN) {
            needsAnchorSmooth[i] = true;
        }
    }

    for (let i = 0; i <= localTotalDays; i++) {
        if (!needsAnchorSmooth[i]) continue;

        let wSum = 0;
        let wResidualSum = 0;
        const globalI = segFirstDay + i;
        const trend_i = smoothGlobalFit.slope * globalI + smoothGlobalFit.intercept;

        for (const a of anchors) {
            const dist = Math.abs(a.dayNumber - globalI);
            if (dist > SMOOTH_HALF) continue;
            const gw = gaussian(dist, SMOOTH_SIGMA);
            const w = gw * a.weight;
            const trend_a = smoothGlobalFit.slope * a.dayNumber + smoothGlobalFit.intercept;
            wResidualSum += w * (a.midpointHour - trend_a);
            wSum += w;
        }

        if (wSum > 0.5) {
            const anchorMid = trend_i + wResidualSum / wSum;
            const anchorWeight = Math.max(0, 1 - distToCore[i]! / SMOOTH_MARGIN);
            const smoothedMid = anchorWeight * anchorMid + (1 - anchorWeight) * rawPredictedMid[i]!;
            rawPredictedMid[i] = smoothedMid;
            const normalizedMid = ((smoothedMid % 24) + 24) % 24;
            const halfDur = rawHalfDur[i]!;
            days[i]!.nightStartHour = normalizedMid - halfDur;
            days[i]!.nightEndHour = normalizedMid + halfDur;
        }
    }

    for (let iter = 0; iter < 3; iter++) {
        for (let i = 1; i <= localTotalDays; i++) {
            if (rawIsForecast[i] || rawIsForecast[i - 1]) continue;
            let curr = rawPredictedMid[i]!;
            const prev = rawPredictedMid[i - 1]!;
            while (curr - prev > 12) curr -= 24;
            while (prev - curr > 12) curr += 24;
            rawPredictedMid[i] = curr;
        }

        const normMid: number[] = [];
        for (let i = 0; i <= localTotalDays; i++) {
            normMid.push(((rawPredictedMid[i]! % 24) + 24) % 24);
        }

        const needsJumpSmooth: boolean[] = new Array(localTotalDays + 1).fill(false);
        let anyJumps = false;
        for (let i = 0; i <= localTotalDays; i++) {
            if (rawIsForecast[i]) continue;
            let maxJump = 0;
            if (i > 0 && !rawIsForecast[i - 1]) {
                let d = Math.abs(normMid[i]! - normMid[i - 1]!);
                if (d > 12) d = 24 - d;
                maxJump = Math.max(maxJump, d);
            }
            if (i < localTotalDays && !rawIsForecast[i + 1]) {
                let d = Math.abs(normMid[i]! - normMid[i + 1]!);
                if (d > 12) d = 24 - d;
                maxJump = Math.max(maxJump, d);
            }
            if (maxJump > SMOOTH_JUMP_THRESH) {
                needsJumpSmooth[i] = true;
                anyJumps = true;
            }
        }

        if (!anyJumps) break;

        const jumpFlagged = needsJumpSmooth.slice();
        for (let i = 0; i <= localTotalDays; i++) {
            if (!jumpFlagged[i]) continue;
            for (let j = Math.max(0, i - SMOOTH_MARGIN); j <= Math.min(localTotalDays, i + SMOOTH_MARGIN); j++) {
                if (!rawIsForecast[j]) needsJumpSmooth[j] = true;
            }
        }

        for (let i = 0; i <= localTotalDays; i++) {
            if (!needsJumpSmooth[i]) continue;

            let wSum = 0;
            let wResidualSum = 0;
            const globalI = segFirstDay + i;
            const trend_i = smoothGlobalFit.slope * globalI + smoothGlobalFit.intercept;

            for (let j = Math.max(0, i - SMOOTH_HALF); j <= Math.min(localTotalDays, i + SMOOTH_HALF); j++) {
                if (rawIsForecast[j]) continue;
                const dist = Math.abs(i - j);
                const gw = gaussian(dist, SMOOTH_SIGMA);
                const w = gw * rawConfScore[j]!;
                const globalJ = segFirstDay + j;
                const trend_j = smoothGlobalFit.slope * globalJ + smoothGlobalFit.intercept;
                wResidualSum += w * (rawPredictedMid[j]! - trend_j);
                wSum += w;
            }

            if (wSum > 0) {
                const smoothedMid = trend_i + wResidualSum / wSum;
                rawPredictedMid[i] = smoothedMid;
                const normalizedMid = ((smoothedMid % 24) + 24) % 24;
                const halfDur = rawHalfDur[i]!;
                days[i]!.nightStartHour = normalizedMid - halfDur;
                days[i]!.nightEndHour = normalizedMid + halfDur;
            }
        }
    }

    {
        const BACKWARD_DEVIATION = 0.5;
        const BACKWARD_MIN_RUN = 3;
        const MAX_BRIDGE_RATE = 3;
        const MIN_CONFIDENCE = 0.3;

        const normMids: number[] = days.map((d) => ((((d.nightStartHour + d.nightEndHour) / 2) % 24) + 24) % 24);

        const getExpectedDelta = (i: number): number => {
            if (i <= 0 || i >= days.length) return 0;
            return (days[i - 1]!.localDrift + days[i]!.localDrift) / 2;
        };

        const isBackward: boolean[] = new Array(days.length).fill(false);
        for (let i = 1; i < days.length; i++) {
            if (days[i]!.isForecast || days[i - 1]!.isForecast) continue;

            const minConf = Math.min(days[i - 1]!.confidenceScore, days[i]!.confidenceScore);
            if (minConf < MIN_CONFIDENCE) continue;

            let delta = normMids[i]! - normMids[i - 1]!;
            if (delta > 12) delta -= 24;
            if (delta < -12) delta += 24;

            const expectedDelta = Math.max(0, getExpectedDelta(i));
            const isBackwardMove = delta < expectedDelta - BACKWARD_DEVIATION;

            if (isBackwardMove) {
                isBackward[i] = true;
            }
        }

        let bRunStart = -1;
        for (let i = 0; i <= days.length; i++) {
            const back = i < days.length && isBackward[i];
            if (back && bRunStart < 0) bRunStart = i;
            else if (!back && bRunStart >= 0) {
                if (i - bRunStart >= BACKWARD_MIN_RUN) {
                    const entryIdx = bRunStart - 1;
                    const exitIdx = i;
                    if (entryIdx >= 0 && exitIdx < days.length && !days[exitIdx]!.isForecast) {
                        const entryMid = normMids[entryIdx]!;
                        const exitMid = normMids[exitIdx]!;
                        const span = exitIdx - entryIdx;

                        const forwardDist = (((exitMid - entryMid) % 24) + 24) % 24;

                        if (Math.abs(forwardDist) / span <= MAX_BRIDGE_RATE && forwardDist !== 0) {
                            for (let j = bRunStart; j < exitIdx; j++) {
                                if (days[j]!.isForecast) continue;
                                const t = (j - entryIdx) / span;
                                const interpolatedMid = (((entryMid + t * forwardDist) % 24) + 24) % 24;
                                const halfDur = rawHalfDur[j]!;
                                days[j]!.nightStartHour = interpolatedMid - halfDur;
                                days[j]!.nightEndHour = interpolatedMid + halfDur;
                            }
                        }
                    }
                }
                bRunStart = -1;
            }
        }
    }

    if (extraDays > 0) {
        const lastDataMid =
            ((((days[localDataDays]!.nightStartHour + days[localDataDays]!.nightEndHour) / 2) % 24) + 24) % 24;
        const edgeSlopeConf =
            Math.min(1, edgeResult.pointsUsed / (medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10)) *
            (1 - Math.min(1, edgeResult.residualMAD / 4));
        const forecastRegionalFit = evaluateWindow(anchors, segFirstDay + localDataDays, REGULARIZATION_HALF);
        const useForecastRegional =
            forecastRegionalFit.pointsUsed >= MIN_ANCHORS_PER_WINDOW &&
            forecastRegionalFit.slope >= -0.5 &&
            forecastRegionalFit.slope <= 2.0;
        const forecastFallbackSlope = useForecastRegional ? forecastRegionalFit.slope : globalFit.slope;
        const edgeSlope = edgeSlopeConf * edgeResult.slope + (1 - edgeSlopeConf) * forecastFallbackSlope;
        for (let localD = localDataDays + 1; localD <= localTotalDays; localD++) {
            const dist = localD - localDataDays;
            const forecastMid = (((lastDataMid + edgeSlope * dist) % 24) + 24) % 24;
            const halfDur = rawHalfDur[localD]!;
            days[localD]!.nightStartHour = forecastMid - halfDur;
            days[localD]!.nightEndHour = forecastMid + halfDur;
        }
    }
}
