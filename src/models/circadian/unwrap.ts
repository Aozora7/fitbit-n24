// Phase unwrapping: seed-based unwrap with regression/pairwise branch resolution
import type { Anchor } from "./types";
import { SEED_HALF, MIN_SEED_ANCHORS, EXPANSION_LOOKBACK_DAYS, GAUSSIAN_SIGMA } from "./types";
import { weightedLinearRegression, gaussian } from "./regression";

// ─── Unwrapping ────────────────────────────────────────────────────

/** Pairwise unwrap on a copy — returns new midpoints without mutating input */
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

/** Find the most consistent region to use as unwrapping seed */
export function findSeedRegion(anchors: Anchor[]): { startIdx: number; endIdx: number; slope: number; intercept: number } {
    const totalSpan = anchors[anchors.length - 1]!.dayNumber - anchors[0]!.dayNumber;

    // Short dataset fallback: use everything
    if (totalSpan < SEED_HALF * 2) {
        const mids = localPairwiseUnwrap(anchors.map(a => a.midpointHour));
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
        // Gather anchors within this window
        const windowStart = center - SEED_HALF;
        const windowEnd = center + SEED_HALF;
        const indices: number[] = [];
        for (let i = 0; i < anchors.length; i++) {
            if (anchors[i]!.dayNumber >= windowStart && anchors[i]!.dayNumber <= windowEnd) {
                indices.push(i);
            }
        }

        if (indices.length < MIN_SEED_ANCHORS) continue;

        // Locally pairwise-unwrap a copy
        const windowMids = localPairwiseUnwrap(indices.map(i => anchors[i]!.midpointHour));
        const pts = indices.map((idx, j) => ({ x: anchors[idx]!.dayNumber, y: windowMids[j]!, w: anchors[idx]!.weight }));
        const fit = weightedLinearRegression(pts);

        // Residual MAD
        const residuals = pts.map(p => Math.abs(p.y - (fit.slope * p.x + fit.intercept)));
        residuals.sort((a, b) => a - b);
        const mad = residuals[Math.floor(residuals.length / 2)]!;

        // Anchor density (fraction of days that have anchors)
        const windowDays = windowEnd - windowStart || 1;
        const density = Math.min(1, indices.length / (windowDays / 2));

        // Average weight
        const avgWeight = pts.reduce((s, p) => s + p.w, 0) / pts.length;

        // Slope plausibility: no penalty for -0.5 to +3.0 h/day
        let slopePenalty = 0;
        if (fit.slope < -0.5) slopePenalty = Math.min(1, (-0.5 - fit.slope) / 5);
        else if (fit.slope > 3.0) slopePenalty = Math.min(1, (fit.slope - 3.0) / 5);

        // Combined score: lower MAD is better, higher density/weight is better
        const madScore = 1 - Math.min(1, mad / 6);
        const score = 0.35 * madScore + 0.25 * density + 0.25 * avgWeight + 0.15 * (1 - slopePenalty);

        if (score > bestScore) {
            bestScore = score;
            bestResult = {
                startIdx: indices[0]!,
                endIdx: indices[indices.length - 1]!,
                slope: fit.slope,
                intercept: fit.intercept
            };
        }
    }

    return bestResult;
}

/** Expand unwrapping from an already-unwrapped region outward */
export function expandFromRegion(anchors: Anchor[], fromIdx: number, toIdx: number, direction: "forward" | "backward"): void {
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

/** Snap anchor[i] to within 12h of prediction from already-unwrapped neighbors.
 *  Uses both regression-based and nearest-neighbor (pairwise) predictions.
 *  When they agree on the 24h branch, uses regression (more informed).
 *  When they disagree and the nearest neighbor is close, prefers pairwise
 *  to avoid regression overextrapolation during fragmented periods. */
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

    if (neighbors.length === 0) return; // leave as-is

    // Regression-based prediction
    let regressionPred: number;
    if (neighbors.length === 1) {
        regressionPred = neighbors[0]!.y;
    } else {
        const fit = weightedLinearRegression(neighbors);
        regressionPred = fit.slope * anchor.dayNumber + fit.intercept;
    }

    // Snap using regression prediction
    let regMid = anchor.midpointHour;
    while (regMid - regressionPred > 12) regMid -= 24;
    while (regressionPred - regMid > 12) regMid += 24;

    // Also snap using nearest neighbor (pairwise)
    let pairMid = anchor.midpointHour;
    while (pairMid - nearestMid > 12) pairMid -= 24;
    while (nearestMid - pairMid > 12) pairMid += 24;

    // If both agree on the branch, use regression (more informed).
    // If they disagree, prefer pairwise only when the anchor is clearly
    // close to the nearest neighbor (< 6h difference) — this prevents
    // regression overextrapolation at fragmentation boundaries while
    // still trusting the regression for genuine 24h branch transitions
    // (where the pairwise difference is 6-12h and ambiguous).
    if (Math.abs(regMid - pairMid) < 1) {
        anchor.midpointHour = regMid;
    } else if (nearestDist <= 7 && Math.abs(pairMid - nearestMid) < 6) {
        anchor.midpointHour = pairMid;
    } else {
        anchor.midpointHour = regMid;
    }
}

/** Seed-based unwrapping: find a clean region, unwrap it, then expand outward */
export function unwrapAnchorsFromSeed(anchors: Anchor[]): void {
    if (anchors.length < 2) return;

    const seed = findSeedRegion(anchors);

    // Phase A: Pairwise-unwrap within the seed region
    const seedMids = localPairwiseUnwrap(
        anchors.slice(seed.startIdx, seed.endIdx + 1).map(a => a.midpointHour)
    );
    for (let i = seed.startIdx; i <= seed.endIdx; i++) {
        anchors[i]!.midpointHour = seedMids[i - seed.startIdx]!;
    }

    // Phase B: Expand forward from seed end
    expandFromRegion(anchors, seed.startIdx, seed.endIdx, "forward");

    // Phase C: Expand backward from seed start
    expandFromRegion(anchors, seed.startIdx, seed.endIdx, "backward");
}
