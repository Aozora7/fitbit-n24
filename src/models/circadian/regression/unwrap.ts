// Phase unwrapping: seed-based unwrap with regression/pairwise branch resolution
import type { Anchor } from "./types";
import { SEED_HALF, MIN_SEED_ANCHORS, EXPANSION_LOOKBACK_DAYS, GAUSSIAN_SIGMA } from "./types";
import { weightedLinearRegression, gaussian } from "./regression";

export function localPairwiseUnwrap(midpoints: number[]): number[] {
    const out = midpoints.slice();
    for (let i = 1; i < out.length; i++) {
        let curr = out[i]!;
        const prev = out[i - 1]!;
        while (curr - prev > 12) curr -= 24;
        while (prev - curr > 12) curr += 24;
        out[i] = curr;
    }
    return out;
}

export function findSeedRegion(anchors: Anchor[]): {
    startIdx: number;
    endIdx: number;
    slope: number;
    intercept: number;
} {
    const totalSpan = anchors[anchors.length - 1]!.dayNumber - anchors[0]!.dayNumber;

    if (totalSpan < SEED_HALF * 2) {
        const mids = localPairwiseUnwrap(anchors.map((a) => a.midpointHour));
        const pts = anchors.map((a, i) => ({ x: a.dayNumber, y: mids[i]!, w: a.weight }));
        const fit = weightedLinearRegression(pts);
        return { startIdx: 0, endIdx: anchors.length - 1, slope: fit.slope, intercept: fit.intercept };
    }

    const firstDay = anchors[0]!.dayNumber;
    const lastDay = anchors[anchors.length - 1]!.dayNumber;
    const step = Math.max(1, Math.floor((lastDay - firstDay - SEED_HALF * 2) / 30) || 1);

    let bestScore = -Infinity;
    let bestResult = { startIdx: 0, endIdx: anchors.length - 1, slope: 0, intercept: 0 };

    for (let center = firstDay + SEED_HALF; center <= lastDay - SEED_HALF; center += step) {
        const windowStart = center - SEED_HALF;
        const windowEnd = center + SEED_HALF;
        const indices: number[] = [];
        for (let i = 0; i < anchors.length; i++) {
            if (anchors[i]!.dayNumber >= windowStart && anchors[i]!.dayNumber <= windowEnd) {
                indices.push(i);
            }
        }

        if (indices.length < MIN_SEED_ANCHORS) continue;

        const windowMids = localPairwiseUnwrap(indices.map((i) => anchors[i]!.midpointHour));
        const pts = indices.map((idx, j) => ({
            x: anchors[idx]!.dayNumber,
            y: windowMids[j]!,
            w: anchors[idx]!.weight,
        }));
        const fit = weightedLinearRegression(pts);

        const residuals = pts.map((p) => Math.abs(p.y - (fit.slope * p.x + fit.intercept)));
        residuals.sort((a, b) => a - b);
        const mad = residuals[Math.floor(residuals.length / 2)]!;

        const windowDays = windowEnd - windowStart || 1;
        const density = Math.min(1, indices.length / (windowDays / 2));

        const avgWeight = pts.reduce((s, p) => s + p.w, 0) / pts.length;

        let slopePenalty = 0;
        if (fit.slope < -0.5) slopePenalty = Math.min(1, (-0.5 - fit.slope) / 5);
        else if (fit.slope > 3.0) slopePenalty = Math.min(1, (fit.slope - 3.0) / 5);

        const madScore = 1 - Math.min(1, mad / 6);
        const score = 0.35 * madScore + 0.25 * density + 0.25 * avgWeight + 0.15 * (1 - slopePenalty);

        if (score > bestScore) {
            bestScore = score;
            bestResult = {
                startIdx: indices[0]!,
                endIdx: indices[indices.length - 1]!,
                slope: fit.slope,
                intercept: fit.intercept,
            };
        }
    }

    return bestResult;
}

export function expandFromRegion(
    anchors: Anchor[],
    fromIdx: number,
    toIdx: number,
    direction: "forward" | "backward"
): void {
    if (direction === "forward") {
        for (let i = toIdx + 1; i < anchors.length; i++) {
            snapToNeighbors(anchors, i, fromIdx, i - 1);
        }
    } else {
        for (let i = fromIdx - 1; i >= 0; i--) {
            snapToNeighbors(anchors, i, i + 1, toIdx);
        }
    }
}

export function snapToNeighbors(anchors: Anchor[], idx: number, refStart: number, refEnd: number): void {
    const anchor = anchors[idx]!;
    const neighbors: { x: number; y: number; w: number }[] = [];

    let nearestDist = Infinity;
    let nearestMid = 0;

    for (let j = refStart; j <= refEnd; j++) {
        const dayDist = Math.abs(anchors[j]!.dayNumber - anchor.dayNumber);
        if (dayDist <= EXPANSION_LOOKBACK_DAYS) {
            const gw = gaussian(dayDist, GAUSSIAN_SIGMA);
            neighbors.push({ x: anchors[j]!.dayNumber, y: anchors[j]!.midpointHour, w: anchors[j]!.weight * gw });
        }
        if (dayDist < nearestDist) {
            nearestDist = dayDist;
            nearestMid = anchors[j]!.midpointHour;
        }
    }

    if (neighbors.length === 0) return;

    let regressionPred: number;
    if (neighbors.length === 1) {
        regressionPred = neighbors[0]!.y;
    } else {
        const fit = weightedLinearRegression(neighbors);
        regressionPred = fit.slope * anchor.dayNumber + fit.intercept;
    }

    let regMid = anchor.midpointHour;
    while (regMid - regressionPred > 12) regMid -= 24;
    while (regressionPred - regMid > 12) regMid += 24;

    let pairMid = anchor.midpointHour;
    while (pairMid - nearestMid > 12) pairMid -= 24;
    while (nearestMid - pairMid > 12) pairMid += 24;

    if (Math.abs(regMid - pairMid) < 1) {
        anchor.midpointHour = regMid;
    } else if (nearestDist <= 7 && Math.abs(pairMid - nearestMid) < 6) {
        anchor.midpointHour = pairMid;
    } else {
        anchor.midpointHour = regMid;
    }
}

export function unwrapAnchorsFromSeed(anchors: Anchor[]): void {
    if (anchors.length < 2) return;

    const seed = findSeedRegion(anchors);

    const seedMids = localPairwiseUnwrap(anchors.slice(seed.startIdx, seed.endIdx + 1).map((a) => a.midpointHour));
    for (let i = seed.startIdx; i <= seed.endIdx; i++) {
        anchors[i]!.midpointHour = seedMids[i - seed.startIdx]!;
    }

    expandFromRegion(anchors, seed.startIdx, seed.endIdx, "forward");

    expandFromRegion(anchors, seed.startIdx, seed.endIdx, "backward");
}
