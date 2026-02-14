// Post-hoc overlay smoothing: 3-pass jump correction and forecast re-anchoring
import type { Anchor, CircadianDay } from "./types";
import { WINDOW_HALF, MIN_ANCHORS_PER_WINDOW, REGULARIZATION_HALF, SMOOTH_HALF, SMOOTH_SIGMA, SMOOTH_JUMP_THRESH } from "./types";
import { gaussian, evaluateWindow, type WindowResult } from "./regression";

export interface SmoothingContext {
    anchors: Anchor[];
    days: CircadianDay[];           // mutated in-place
    rawPredictedMid: number[];      // mutated in-place
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

/**
 * 3-pass post-hoc smoothing of overlay predictions.
 *
 * Pass 1: Anchor-based smoothing for low-slopeConf days
 * Pass 2: Iterative jump-based prediction smoothing
 * Pass 3: Forward-bridge backward-moving overlay segments
 *
 * Then recomputes forecast days for continuity with the smoothed last data day.
 */
export function smoothOverlay(ctx: SmoothingContext): void {
    const {
        anchors, days, rawPredictedMid, rawConfScore, rawIsForecast,
        rawSlopeConf, rawHalfDur, segFirstDay, localDataDays, localTotalDays,
        edgeResult, medianSpacing, globalFit, extraDays
    } = ctx;

    // Step 7: Jump-targeted overlay smoothing
    // Only smooth days where raw predictions create a large jump (>SMOOTH_JUMP_THRESH)
    // from neighbors. This fixes window-expansion artifacts during fragmented sleep
    // without affecting well-estimated days' drift tracking.

    // 7a: Pairwise-unwrap raw predictions to remove 24h steps
    for (let i = 1; i <= localTotalDays; i++) {
        if (rawIsForecast[i] || rawIsForecast[i - 1]) continue;
        let curr = rawPredictedMid[i]!;
        const prev = rawPredictedMid[i - 1]!;
        while (curr - prev > 12) curr -= 24;
        while (prev - curr > 12) curr += 24;
        rawPredictedMid[i] = curr;
    }

    // 7b: Two-pass smoothing
    // Pass 1: Anchor-based smoothing for low-confidence days (fixes slope)
    // Pass 2: Jump-based prediction smoothing (fixes remaining discontinuities)

    const smoothGlobalFit = evaluateWindow(
        anchors,
        anchors[Math.floor(anchors.length / 2)]!.dayNumber,
        anchors[anchors.length - 1]!.dayNumber
    );

    // Pass 1: Anchor-based smoothing for low-slopeConf days
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

        // Require meaningful anchor coverage (not just a single distant anchor)
        if (wSum > 0.5) {
            const anchorMid = trend_i + wResidualSum / wSum;
            // Blend: core days (distToCore=0) get full anchor weight;
            // margin days fade linearly to 0 at SMOOTH_MARGIN
            const anchorWeight = Math.max(0, 1 - distToCore[i]! / SMOOTH_MARGIN);
            const smoothedMid = anchorWeight * anchorMid + (1 - anchorWeight) * rawPredictedMid[i]!;
            rawPredictedMid[i] = smoothedMid;
            const normalizedMid = ((smoothedMid % 24) + 24) % 24;
            const halfDur = rawHalfDur[i]!;
            days[i]!.nightStartHour = normalizedMid - halfDur;
            days[i]!.nightEndHour = normalizedMid + halfDur;
        }
    }

    // Pass 2: Iterative jump-based prediction smoothing
    // Repeatedly detect and smooth jumps until none >SMOOTH_JUMP_THRESH remain.
    // Usually converges in 1-2 iterations; cap at 3 for safety.
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

    // Pass 3: Forward-bridge backward-moving overlay segments
    // When disrupted sleep pulls the overlay backward (against the local
    // drift direction) for several consecutive days, replace with forward
    // circular interpolation between entry and exit points. The circadian
    // clock doesn't run backward, so backward overlay movement indicates
    // the regression is tracking off-rhythm sleep rather than the phase.
    {
        const BACKWARD_DEVIATION = 0.5; // flag if daily shift deviates 0.5h+ backward from expected
        const BACKWARD_MIN_RUN = 3; // min consecutive backward days to trigger bridging
        const MAX_BRIDGE_RATE = 3; // max h/day interpolation rate (sanity check)
        const MIN_CONFIDENCE = 0.3; // only bridge days with sufficient confidence in their local drift

        const normMids: number[] = days.map(d =>
            (((d.nightStartHour + d.nightEndHour) / 2) % 24 + 24) % 24
        );

        // Use local drift estimates for context-aware bridging.
        // This prevents false bridging when short entrained segments (tau=24.0)
        // are surrounded by longer N24 segments (tau>24.0).
        const getExpectedDelta = (i: number): number => {
            if (i <= 0 || i >= days.length) return 0;
            // Average the local drift of consecutive days for smoother transitions
            return (days[i - 1]!.localDrift + days[i]!.localDrift) / 2;
        };

        // Flag days where the overlay moves backward relative to LOCAL expected drift
        const isBackward: boolean[] = new Array(days.length).fill(false);
        for (let i = 1; i < days.length; i++) {
            if (days[i]!.isForecast || days[i - 1]!.isForecast) continue;

            // Skip bridging for low-confidence days (prevents false bridging
            // in segments with insufficient anchor coverage)
            const minConf = Math.min(days[i - 1]!.confidenceScore, days[i]!.confidenceScore);
            if (minConf < MIN_CONFIDENCE) continue;

            let delta = normMids[i]! - normMids[i - 1]!;
            if (delta > 12) delta -= 24;
            if (delta < -12) delta += 24;

            // Clamp expected delta to >= 0: the circadian clock doesn't run backward,
            // so negative local drift is always estimation noise from fragmented sleep.
            // Without clamping, negative localDrift causes the bridging to "expect"
            // backward movement, preventing detection of genuine overlay reversal.
            const expectedDelta = Math.max(0, getExpectedDelta(i));
            const isBackwardMove = delta < expectedDelta - BACKWARD_DEVIATION;

            if (isBackwardMove) {
                isBackward[i] = true;
            }
        }

        // Find contiguous backward runs and forward-interpolate
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

                        // Always interpolate forward (positive direction).
                        // The circadian clock doesn't run backward, so backward
                        // bridge direction from negative localDrift is always noise.
                        const forwardDist = ((exitMid - entryMid) % 24 + 24) % 24;

                        // Sanity: skip if interpolation rate is implausible
                        if (Math.abs(forwardDist) / span <= MAX_BRIDGE_RATE && forwardDist !== 0) {
                            for (let j = bRunStart; j < exitIdx; j++) {
                                if (days[j]!.isForecast) continue;
                                const t = (j - entryIdx) / span;
                                const interpolatedMid = ((entryMid + t * forwardDist) % 24 + 24) % 24;
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

    // Recompute forecast days to maintain continuity with the (now smoothed)
    // last data day.
    if (extraDays > 0) {
        const lastDataMid = (((days[localDataDays]!.nightStartHour + days[localDataDays]!.nightEndHour) / 2) % 24 + 24) % 24;
        const edgeSlopeConf = Math.min(1, edgeResult.pointsUsed / (medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10)) *
                              (1 - Math.min(1, edgeResult.residualMAD / 4));
        // Use regional fit centered on last data day for fallback (not global, which may encode
        // a different regime like DSPD). Fall back to global only if regional is implausible.
        const forecastRegionalFit = evaluateWindow(anchors, segFirstDay + localDataDays, REGULARIZATION_HALF);
        const useForecastRegional = forecastRegionalFit.pointsUsed >= MIN_ANCHORS_PER_WINDOW &&
                                    forecastRegionalFit.slope >= -0.5 && forecastRegionalFit.slope <= 2.0;
        const forecastFallbackSlope = useForecastRegional ? forecastRegionalFit.slope : globalFit.slope;
        const edgeSlope = edgeSlopeConf * edgeResult.slope + (1 - edgeSlopeConf) * forecastFallbackSlope;
        for (let localD = localDataDays + 1; localD <= localTotalDays; localD++) {
            const dist = localD - localDataDays;
            const forecastMid = ((lastDataMid + edgeSlope * dist) % 24 + 24) % 24;
            const halfDur = rawHalfDur[localD]!;
            days[localD]!.nightStartHour = forecastMid - halfDur;
            days[localD]!.nightEndHour = forecastMid + halfDur;
        }
    }
}
