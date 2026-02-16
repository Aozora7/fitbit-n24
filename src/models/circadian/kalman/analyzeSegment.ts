// Per-segment Kalman filter pipeline: init → forward filter → RTS smoother → output
import type { SleepRecord } from "../../../api/types";
import type { CircadianDay } from "../types";
import type { State, Cov, Observation } from "./types";
import { GATE_THRESHOLD, INIT_WINDOW, DEFAULT_DRIFT_PRIOR, INIT_P_PHASE, INIT_P_DRIFT } from "./types";
import { predict, update, gate, resolveAmbiguity } from "./filter";
import { rtsSmoother } from "./smoother";
import { extractObservations } from "./observations";

export interface KalmanSegmentResult {
    days: CircadianDay[];
    segFirstDay: number;
    segLastDay: number;
    gatedCount: number;
    observationCount: number;
    innovationSum: number;
}

/**
 * Initialize state from the first few observations via weighted linear regression.
 */
function initializeState(observations: Map<number, Observation>, segFirstDay: number): { state: State; cov: Cov } {
    // Collect observations within the init window
    const initObs: Observation[] = [];
    for (let d = segFirstDay; d <= segFirstDay + INIT_WINDOW * 2 && initObs.length < INIT_WINDOW; d++) {
        const obs = observations.get(d);
        if (obs) initObs.push(obs);
    }

    if (initObs.length === 0) {
        // No observations at all — use priors
        return {
            state: [12, DEFAULT_DRIFT_PRIOR],
            cov: [INIT_P_PHASE * 4, 0, INIT_P_DRIFT * 4],
        };
    }

    if (initObs.length === 1) {
        // Single observation — use it for phase, prior for drift
        return {
            state: [initObs[0]!.midpointHour, DEFAULT_DRIFT_PRIOR],
            cov: [INIT_P_PHASE, 0, INIT_P_DRIFT],
        };
    }

    // Fit weighted linear regression: midpoint = intercept + slope * dayNumber
    let sw = 0,
        sx = 0,
        sy = 0,
        sxx = 0,
        sxy = 0;
    for (const obs of initObs) {
        const w = 1 / obs.R; // Weight inversely proportional to noise
        const x = obs.dayNumber;
        const y = obs.midpointHour;
        sw += w;
        sx += w * x;
        sy += w * y;
        sxx += w * x * x;
        sxy += w * x * y;
    }

    const denom = sw * sxx - sx * sx;
    let slope: number;
    let intercept: number;

    if (Math.abs(denom) < 1e-10) {
        slope = DEFAULT_DRIFT_PRIOR;
        intercept = sy / sw;
    } else {
        slope = (sw * sxy - sx * sy) / denom;
        intercept = (sy * sxx - sx * sxy) / denom;
    }

    // Clamp initial slope to reasonable range
    slope = Math.max(-1.5, Math.min(3.0, slope));

    // Initial phase at segFirstDay
    const phase0 = intercept + slope * segFirstDay;

    return {
        state: [phase0, slope],
        cov: [INIT_P_PHASE, 0, INIT_P_DRIFT],
    };
}

/**
 * Format a day number (relative to globalFirstDateMs) as YYYY-MM-DD string.
 */
function dayToDateStr(dayNumber: number, firstDate: Date): string {
    const d = new Date(firstDate);
    d.setDate(firstDate.getDate() + dayNumber);
    return (
        d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0")
    );
}

/**
 * Convert posterior covariance to confidence score in [0, 1].
 * Lower phase uncertainty → higher confidence.
 */
function covToConfidence(phaseCov: number): number {
    const phaseStd = Math.sqrt(Math.max(0, phaseCov));
    // Map std to confidence: std=0 → 1.0, std=2 → 0.5, std→∞ → 0
    return 1 / (1 + phaseStd);
}

/**
 * Gaussian-weighted average sleep duration from nearby observations.
 * Uses sigma=7 days to produce a smooth duration estimate.
 */
function getLocalDuration(observations: Map<number, Observation>, dayNumber: number, fallback: number): number {
    const SIGMA = 3;
    const HALF_WINDOW = 4;
    let wSum = 0;
    let durSum = 0;

    for (let offset = -HALF_WINDOW; offset <= HALF_WINDOW; offset++) {
        const obs = observations.get(dayNumber + offset);
        if (obs) {
            const w = Math.exp(-0.5 * (offset / SIGMA) ** 2);
            wSum += w;
            durSum += w * obs.record.durationHours;
        }
    }

    return wSum > 0 ? durSum / wSum : fallback;
}

export function analyzeSegment(
    records: SleepRecord[],
    extraDays: number,
    globalFirstDateMs: number
): KalmanSegmentResult | null {
    if (records.length === 0) return null;

    const observations = extractObservations(records, globalFirstDateMs);
    if (observations.size < 1) return null;

    // Determine segment boundaries
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const segFirstDay = Math.round(
        (new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
    );
    const segLastDay = Math.round(
        (new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
    );
    const numDataDays = segLastDay - segFirstDay;
    const totalDays = numDataDays + extraDays;

    // Initialize
    const init = initializeState(observations, segFirstDay);

    // --- Forward Kalman pass ---
    const filteredStates: State[] = [];
    const filteredCovs: Cov[] = [];
    const predictedStates: State[] = [];
    const predictedCovs: Cov[] = [];
    const dayHasObs: boolean[] = [];

    let state = init.state;
    let cov = init.cov;
    let gatedCount = 0;
    let obsCount = 0;
    let innovationSum = 0;
    let innovationCount = 0;

    for (let localD = 0; localD <= totalDays; localD++) {
        const globalD = segFirstDay + localD;

        // Predict
        const pred = predict(state, cov);
        predictedStates.push(pred.state);
        predictedCovs.push(pred.cov);

        state = pred.state;
        cov = pred.cov;

        // Update if observation exists (and not in forecast zone)
        const obs = localD <= numDataDays ? observations.get(globalD) : undefined;
        let hasObs = false;

        if (obs) {
            obsCount++;
            const zUnwrapped = resolveAmbiguity(obs.midpointHour, state[0]);

            if (gate(state, cov, zUnwrapped, obs.R, GATE_THRESHOLD)) {
                // Outlier — skip update
                gatedCount++;
            } else {
                const upd = update(state, cov, zUnwrapped, obs.R);
                state = upd.state;
                cov = upd.cov;
                innovationSum += Math.abs(upd.innovation);
                innovationCount++;
                hasObs = true;
            }
        }

        filteredStates.push(state);
        filteredCovs.push(cov);
        dayHasObs.push(hasObs);
    }

    // --- RTS backward smoother ---
    const smoothed = rtsSmoother(filteredStates, filteredCovs, predictedStates, predictedCovs);

    // --- Output generation ---
    const firstDate = new Date(globalFirstDateMs);
    const days: CircadianDay[] = [];

    // Compute median duration for fallback
    let durSum = 0;
    let durCount = 0;
    for (const obs of observations.values()) {
        durSum += obs.record.durationHours;
        durCount++;
    }
    const medianDur = durCount > 0 ? durSum / durCount : 8;

    for (let localD = 0; localD <= totalDays; localD++) {
        const globalD = segFirstDay + localD;
        const dateStr = dayToDateStr(globalD, firstDate);
        const isForecast = localD > numDataDays;

        const sState = smoothed.states[localD]!;
        const sCov = smoothed.covs[localD]!;

        // Extract drift, clamp to hard limits
        let drift = sState[1];
        drift = Math.max(-1.5, Math.min(3.0, drift));

        const localTau = 24 + drift;

        // Phase → normalized midpoint
        const phase = sState[0];
        const normalizedMid = ((phase % 24) + 24) % 24;

        // Duration from nearby observation or fallback
        const halfDur = getLocalDuration(observations, globalD, medianDur) / 2;

        // Confidence from posterior covariance
        let confScore = covToConfidence(sCov[0]);

        // Reduce confidence for forecast days
        if (isForecast) {
            const distFromEdge = localD - numDataDays;
            confScore *= Math.exp(-0.1 * distFromEdge);
        }

        const obs = observations.get(globalD);

        days.push({
            date: dateStr,
            nightStartHour: normalizedMid - halfDur,
            nightEndHour: normalizedMid + halfDur,
            confidenceScore: confScore,
            confidence: confScore >= 0.6 ? "high" : confScore >= 0.3 ? "medium" : "low",
            localTau,
            localDrift: drift,
            anchorSleep: obs?.record,
            isForecast,
            isGap: false,
        });
    }

    return {
        days,
        segFirstDay,
        segLastDay,
        gatedCount,
        observationCount: obsCount,
        innovationSum: innovationCount > 0 ? innovationSum / innovationCount : 0,
    };
}
