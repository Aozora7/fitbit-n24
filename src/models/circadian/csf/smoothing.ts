import type { SmoothedState, CSFAnchor } from "./types";

const EDGE_WINDOW = 10;
const ANCHOR_HALF_WINDOW = 15;
const ANCHOR_SIGMA = 7;

/**
 * Correct the last EDGE_WINDOW data-backed days by blending RTS-smoothed
 * estimates with anchor-based estimates, then re-anchor forecast days using
 * linear extrapolation from the corrected last data day.
 *
 * The RTS smoother's terminal state is unsmoothed, causing the last several
 * data days to lag behind observations. Forecast days compound this error
 * because they use the uncorrected forward-pass phase and a tau that
 * underestimates actual drift.
 *
 * Works in unwrapped clock-hour space to avoid scale mismatch between
 * smoothedPhase (drift-accumulated) and anchor midpointHour (absolute hours).
 */
export function correctEdge(
    states: SmoothedState[],
    anchors: CSFAnchor[],
    segFirstDay: number,
    lastDataLocalDay: number,
    totalDays: number
): void {
    if (anchors.length < 3 || lastDataLocalDay < EDGE_WINDOW) return;

    // Build unwrapped clock hours for anchors: take mod 24, then unwrap
    // relative to first anchor so phase is continuous
    const fitRadius = 30;
    const recentAnchors = anchors.filter(
        (a) => a.dayNumber >= segFirstDay + lastDataLocalDay - fitRadius && a.dayNumber <= segFirstDay + lastDataLocalDay
    );
    if (recentAnchors.length < 3) return;

    const unwrappedHours: { dayNumber: number; clockHour: number; weight: number }[] = [];
    let prevHour = ((recentAnchors[0]!.midpointHour % 24) + 24) % 24;
    unwrappedHours.push({ dayNumber: recentAnchors[0]!.dayNumber, clockHour: prevHour, weight: recentAnchors[0]!.weight });

    for (let i = 1; i < recentAnchors.length; i++) {
        let h = ((recentAnchors[i]!.midpointHour % 24) + 24) % 24;
        // Unwrap: choose branch closest to previous (allow forward drift)
        while (h - prevHour > 12) h -= 24;
        while (prevHour - h > 12) h += 24;
        unwrappedHours.push({ dayNumber: recentAnchors[i]!.dayNumber, clockHour: h, weight: recentAnchors[i]!.weight });
        prevHour = h;
    }

    // Weighted linear regression on unwrapped clock hours vs dayNumber
    let sumW = 0,
        sumWx = 0,
        sumWy = 0,
        sumWxx = 0,
        sumWxy = 0;
    for (const a of unwrappedHours) {
        const w = a.weight;
        sumW += w;
        sumWx += w * a.dayNumber;
        sumWy += w * a.clockHour;
        sumWxx += w * a.dayNumber * a.dayNumber;
        sumWxy += w * a.dayNumber * a.clockHour;
    }
    const denom = sumW * sumWxx - sumWx * sumWx;
    if (Math.abs(denom) < 1e-10) return;
    const slope = (sumW * sumWxy - sumWx * sumWy) / denom;
    const intercept = (sumWy - slope * sumWx) / sumW;

    // --- Phase 1: Correct data-backed edge days ---
    const edgeStart = Math.max(0, lastDataLocalDay - EDGE_WINDOW);
    for (let localD = edgeStart; localD <= Math.min(lastDataLocalDay, totalDays); localD++) {
        const state = states[localD];
        if (!state) continue;

        const globalD = segFirstDay + localD;

        // Gaussian-weighted mean of residuals from nearby anchors
        let wResSum = 0;
        let wSum = 0;
        for (const a of unwrappedHours) {
            const dist = Math.abs(a.dayNumber - globalD);
            if (dist > ANCHOR_HALF_WINDOW) continue;
            const gw = Math.exp(-0.5 * (dist / ANCHOR_SIGMA) ** 2);
            const w = gw * a.weight;
            const trendAtAnchor = slope * a.dayNumber + intercept;
            wResSum += w * (a.clockHour - trendAtAnchor);
            wSum += w;
        }

        if (wSum < 0.5) continue;

        // Target clock hour from anchor-based fit
        const targetClockHour = slope * globalD + intercept + wResSum / wSum;

        // Bring smoothedPhase to the correct branch to match target clock hour
        const currentClockHour = ((state.smoothedPhase % 24) + 24) % 24;
        let correction = targetClockHour - currentClockHour;
        // Normalize correction to [-12, 12]
        while (correction > 12) correction -= 24;
        while (correction < -12) correction += 24;

        // Blend weight: 0 at edgeStart, 1 at lastDataLocalDay
        const t = EDGE_WINDOW > 0 ? (localD - edgeStart) / EDGE_WINDOW : 1;
        const blendWeight = t * t; // Quadratic ramp — stronger correction at the very end

        state.smoothedPhase += blendWeight * correction;
    }

    // --- Phase 2: Re-anchor forecast days ---
    // Extrapolate from the corrected last data day using the anchor-based slope
    if (lastDataLocalDay < totalDays) {
        const lastDataState = states[lastDataLocalDay];
        if (!lastDataState) return;

        const lastDataClockHour = ((lastDataState.smoothedPhase % 24) + 24) % 24;

        for (let localD = lastDataLocalDay + 1; localD <= totalDays; localD++) {
            const state = states[localD];
            if (!state) continue;

            const dist = localD - lastDataLocalDay;
            const forecastClockHour = lastDataClockHour + slope * dist;

            // Set smoothedPhase to the correct branch
            const currentClockHour = ((state.smoothedPhase % 24) + 24) % 24;
            let correction = forecastClockHour - currentClockHour;
            while (correction > 12) correction -= 24;
            while (correction < -12) correction += 24;

            state.smoothedPhase += correction;
            // Update tau to reflect the anchor-based drift rate
            state.smoothedTau = 24 + slope;
        }
    }
}

export function smoothOutputPhase(
    states: SmoothedState[],
    sigmaDays: number = 2,
    halfWindow: number = 3
): SmoothedState[] {
    if (states.length < 3) return states;

    const smoothed: SmoothedState[] = states.map((s) => ({ ...s }));

    for (let i = 0; i < states.length; i++) {
        let phaseSum = 0;
        let tauSum = 0;
        let weightSum = 0;

        for (let j = Math.max(0, i - halfWindow); j <= Math.min(states.length - 1, i + halfWindow); j++) {
            const dist = Math.abs(j - i);
            const weight = Math.exp(-0.5 * (dist / sigmaDays) ** 2);
            phaseSum += weight * states[j]!.smoothedPhase;
            tauSum += weight * states[j]!.smoothedTau;
            weightSum += weight;
        }

        if (weightSum > 0) {
            smoothed[i]!.smoothedPhase = phaseSum / weightSum;
            smoothed[i]!.smoothedTau = tauSum / weightSum;
        }
    }

    return smoothed;
}
