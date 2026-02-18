import type { SmoothedState, CSFAnchor } from "./types";

const EDGE_WINDOW = 10;
const ANCHOR_HALF_WINDOW = 15;
const ANCHOR_SIGMA = 7;

type EdgeType = "start" | "end";

interface RegressionResult {
    slope: number;
    intercept: number;
    unwrappedHours: { dayNumber: number; clockHour: number; weight: number }[];
}

function buildUnwrappedHours(anchors: CSFAnchor[], dayStart: number, dayEnd: number): RegressionResult | null {
    const selected = anchors.filter((a) => a.dayNumber >= dayStart && a.dayNumber <= dayEnd);
    if (selected.length < 3) return null;

    const pivotIdx = selected.reduce((bestIdx, a, i, arr) => (a.weight > arr[bestIdx]!.weight ? i : bestIdx), 0);
    const pivot = selected[pivotIdx]!;

    const unwrappedHours: { dayNumber: number; clockHour: number; weight: number }[] = [];

    const pivotClockHour = ((pivot.midpointHour % 24) + 24) % 24;
    unwrappedHours.push({ dayNumber: pivot.dayNumber, clockHour: pivotClockHour, weight: pivot.weight });

    let prevHour = pivotClockHour;
    for (let i = pivotIdx - 1; i >= 0; i--) {
        let h = ((selected[i]!.midpointHour % 24) + 24) % 24;
        while (h - prevHour > 12) h -= 24;
        while (prevHour - h > 12) h += 24;
        unwrappedHours.unshift({ dayNumber: selected[i]!.dayNumber, clockHour: h, weight: selected[i]!.weight });
        prevHour = h;
    }

    prevHour = pivotClockHour;
    for (let i = pivotIdx + 1; i < selected.length; i++) {
        let h = ((selected[i]!.midpointHour % 24) + 24) % 24;
        while (h - prevHour > 12) h -= 24;
        while (prevHour - h > 12) h += 24;
        unwrappedHours.push({ dayNumber: selected[i]!.dayNumber, clockHour: h, weight: selected[i]!.weight });
        prevHour = h;
    }

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
    if (Math.abs(denom) < 1e-10) return null;
    const slope = (sumW * sumWxy - sumWx * sumWy) / denom;
    const intercept = (sumWy - slope * sumWx) / sumW;

    return { slope, intercept, unwrappedHours };
}

function correctSingleEdge(
    states: SmoothedState[],
    anchors: CSFAnchor[],
    segFirstDay: number,
    edge: EdgeType,
    edgeLocalDay: number,
    totalDays: number
): void {
    const fitRadius = 30;

    let dayStart: number, dayEnd: number;
    if (edge === "end") {
        dayStart = segFirstDay + edgeLocalDay - fitRadius;
        dayEnd = segFirstDay + edgeLocalDay;
    } else {
        dayStart = segFirstDay;
        dayEnd = segFirstDay + fitRadius;
    }

    const reg = buildUnwrappedHours(anchors, dayStart, dayEnd);
    if (!reg) return;

    const { slope, intercept, unwrappedHours } = reg;

    const edgeEnd = edge === "end" ? Math.min(edgeLocalDay, totalDays) : EDGE_WINDOW - 1;
    const edgeStart = edge === "end" ? Math.max(0, edgeLocalDay - EDGE_WINDOW) : 0;

    for (let localD = edgeStart; localD <= edgeEnd; localD++) {
        const state = states[localD];
        if (!state) continue;

        const globalD = segFirstDay + localD;

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

        const targetClockHour = slope * globalD + intercept + wResSum / wSum;
        const currentClockHour = ((state.smoothedPhase % 24) + 24) % 24;
        let correction = targetClockHour - currentClockHour;
        while (correction > 12) correction -= 24;
        while (correction < -12) correction += 24;

        let t: number;
        if (edge === "end") {
            t = EDGE_WINDOW > 0 ? (localD - edgeStart) / EDGE_WINDOW : 1;
        } else {
            t = EDGE_WINDOW > 0 ? 1 - localD / EDGE_WINDOW : 1;
        }
        const blendWeight = t * t;

        state.smoothedPhase += blendWeight * correction;
    }

    if (edge === "end" && edgeLocalDay < totalDays) {
        const lastDataState = states[edgeLocalDay];
        if (!lastDataState) return;

        const lastDataClockHour = ((lastDataState.smoothedPhase % 24) + 24) % 24;

        for (let localD = edgeLocalDay + 1; localD <= totalDays; localD++) {
            const state = states[localD];
            if (!state) continue;

            const dist = localD - edgeLocalDay;
            const forecastClockHour = lastDataClockHour + slope * dist;

            const currentClockHour = ((state.smoothedPhase % 24) + 24) % 24;
            let correction = forecastClockHour - currentClockHour;
            while (correction > 12) correction -= 24;
            while (correction < -12) correction += 24;

            state.smoothedPhase += correction;
            state.smoothedTau = 24 + slope;
        }
    }
}

function correctStartEdgeFromInterior(states: SmoothedState[]): void {
    // Use well-converged states from day 15-25 to estimate the phase trend,
    // then extrapolate backward to correct the start edge.
    const REF_START = 15;
    const REF_END = 25;

    if (states.length <= REF_END) return;

    // Collect reference states with valid phase
    const refPoints: { localD: number; phase: number }[] = [];
    for (let localD = REF_START; localD <= REF_END && localD < states.length; localD++) {
        const s = states[localD];
        if (s) {
            refPoints.push({ localD, phase: s.smoothedPhase });
        }
    }

    if (refPoints.length < 5) return;

    // Linear regression on phase vs localD
    let n = 0,
        sumX = 0,
        sumY = 0,
        sumXX = 0,
        sumXY = 0;
    for (const p of refPoints) {
        n++;
        sumX += p.localD;
        sumY += p.phase;
        sumXX += p.localD * p.localD;
        sumXY += p.localD * p.phase;
    }

    const denom = n * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-10) return;

    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;

    // Extrapolate back to day 0 and apply correction
    for (let localD = 0; localD < EDGE_WINDOW && localD < states.length; localD++) {
        const state = states[localD];
        if (!state) continue;

        const targetPhase = slope * localD + intercept;
        let correction = targetPhase - state.smoothedPhase;
        // Don't make huge corrections - limit to 6h
        correction = Math.max(-6, Math.min(6, correction));

        // Quadratic blend: full correction at day 0, no correction at day EDGE_WINDOW
        const t = EDGE_WINDOW > 0 ? 1 - localD / EDGE_WINDOW : 1;
        const blendWeight = t * t;

        state.smoothedPhase += blendWeight * correction;
    }
}

export function correctEdges(
    states: SmoothedState[],
    anchors: CSFAnchor[],
    segFirstDay: number,
    lastDataLocalDay: number,
    totalDays: number
): void {
    if (anchors.length < 3) return;
    if (lastDataLocalDay < EDGE_WINDOW) return;

    // Correct start edge using interior states (more reliable than early anchors)
    correctStartEdgeFromInterior(states);

    // Correct end edge using anchor-based regression
    correctSingleEdge(states, anchors, segFirstDay, "end", lastDataLocalDay, totalDays);
}

/** @deprecated Use correctEdges instead */
export const correctEdge = correctEdges;

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
