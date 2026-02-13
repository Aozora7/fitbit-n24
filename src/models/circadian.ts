import type { SleepRecord } from "../api/types";

// ─── Public interfaces ─────────────────────────────────────────────

export interface CircadianDay {
    date: string;
    nightStartHour: number;
    nightEndHour: number;
    confidenceScore: number;
    confidence: "high" | "medium" | "low";
    localTau: number;
    localDrift: number;
    anchorSleep?: SleepRecord;
    isForecast: boolean;
}

export interface AnchorPoint {
    dayNumber: number;
    midpointHour: number; // unwrapped hours from first day's midnight
    weight: number;
    tier: "A" | "B" | "C";
    date: string;
}

export interface CircadianAnalysis {
    globalTau: number;
    globalDailyDrift: number;
    days: CircadianDay[];
    anchors: AnchorPoint[];
    medianResidualHours: number;
    anchorCount: number;
    anchorTierCounts: { A: number; B: number; C: number };
    // Legacy compat
    tau: number;
    dailyDrift: number;
    rSquared: number;
}

// ─── Anchor types ──────────────────────────────────────────────────

type AnchorTier = "A" | "B" | "C";

interface Anchor {
    dayNumber: number;
    midpointHour: number; // hours from first day's midnight (unwrapped)
    weight: number;
    tier: AnchorTier;
    record: SleepRecord;
    date: string;
}

// ─── Constants ─────────────────────────────────────────────────────

const WINDOW_HALF = 21; // 42-day window
const MAX_WINDOW_HALF = 60; // expand to 120 days if sparse
const MIN_ANCHORS_PER_WINDOW = 6;
const GAUSSIAN_SIGMA = 14; // half-weight at 14 days from center
const OUTLIER_THRESHOLD_HOURS = 8; // only catch genuine data errors
const SEED_HALF = 21; // half-width of seed search window
const MIN_SEED_ANCHORS = 4; // minimum anchors to evaluate a seed window
const EXPANSION_LOOKBACK_DAYS = 30; // how far back to look when expanding

// ─── Anchor classification ─────────────────────────────────────────

interface AnchorCandidate {
    record: SleepRecord;
    quality: number;
    tier: AnchorTier;
    weight: number;
}

function classifyAnchor(record: SleepRecord): AnchorCandidate | null {
    const quality = record.sleepScore;
    const dur = record.durationHours;

    let tier: AnchorTier;
    let baseWeight: number;

    if (dur >= 7 && quality >= 0.75) {
        tier = "A";
        baseWeight = 1.0;
    } else if (dur >= 5 && quality >= 0.6) {
        tier = "B";
        baseWeight = 0.4;
    } else if (dur >= 4 && quality >= 0.4) {
        tier = "C";
        baseWeight = 0.1;
    } else {
        return null;
    }

    const durFactor = Math.min(1, (dur - 4) / 5);
    let weight = baseWeight * quality * durFactor;

    // Naps still contribute data but can't dominate regression or unwrapping
    if (!record.isMainSleep) {
        weight *= 0.15;
    }

    return { record, quality, tier, weight };
}

// ─── Midpoint computation ──────────────────────────────────────────

/** Compute midpoint as absolute hours from a fixed epoch (firstDateMs) */
function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

// ─── Unwrapping ────────────────────────────────────────────────────

/** Pairwise unwrap on a copy — returns new midpoints without mutating input */
function localPairwiseUnwrap(midpoints: number[]): number[] {
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
function findSeedRegion(anchors: Anchor[]): { startIdx: number; endIdx: number; slope: number; intercept: number } {
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
function expandFromRegion(anchors: Anchor[], fromIdx: number, toIdx: number, direction: "forward" | "backward"): void {
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

/** Snap anchor[i] to within 12h of prediction from already-unwrapped neighbors */
function snapToNeighbors(anchors: Anchor[], idx: number, refStart: number, refEnd: number): void {
    const anchor = anchors[idx]!;
    const neighbors: { x: number; y: number; w: number }[] = [];

    for (let j = refStart; j <= refEnd; j++) {
        const dayDist = Math.abs(anchors[j]!.dayNumber - anchor.dayNumber);
        if (dayDist <= EXPANSION_LOOKBACK_DAYS) {
            const gw = gaussian(dayDist, GAUSSIAN_SIGMA);
            neighbors.push({ x: anchors[j]!.dayNumber, y: anchors[j]!.midpointHour, w: anchors[j]!.weight * gw });
        }
    }

    if (neighbors.length === 0) return; // leave as-is

    let predicted: number;
    if (neighbors.length === 1) {
        predicted = neighbors[0]!.y;
    } else {
        const fit = weightedLinearRegression(neighbors);
        predicted = fit.slope * anchor.dayNumber + fit.intercept;
    }

    let mid = anchor.midpointHour;
    while (mid - predicted > 12) mid -= 24;
    while (predicted - mid > 12) mid += 24;
    anchor.midpointHour = mid;
}

/** Seed-based unwrapping: find a clean region, unwrap it, then expand outward */
function unwrapAnchorsFromSeed(anchors: Anchor[]): void {
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

// ─── Weighted linear regression ────────────────────────────────────

function weightedLinearRegression(points: { x: number; y: number; w: number }[]): { slope: number; intercept: number } {
    let sumW = 0,
        sumWX = 0,
        sumWY = 0,
        sumWXX = 0,
        sumWXY = 0;

    for (const p of points) {
        sumW += p.w;
        sumWX += p.w * p.x;
        sumWY += p.w * p.y;
        sumWXX += p.w * p.x * p.x;
        sumWXY += p.w * p.x * p.y;
    }

    const denom = sumW * sumWXX - sumWX * sumWX;
    if (denom === 0 || sumW === 0) {
        return { slope: 0, intercept: sumW > 0 ? sumWY / sumW : 0 };
    }

    return {
        slope: (sumW * sumWXY - sumWX * sumWY) / denom,
        intercept: (sumWY * sumWXX - sumWX * sumWXY) / denom
    };
}

// ─── Robust regression (IRLS with Tukey bisquare) ─────────────────

function robustWeightedRegression(points: { x: number; y: number; w: number }[], maxIter = 5, tuningConstant = 4.685): { slope: number; intercept: number } {
    if (points.length < 2) {
        return { slope: 0, intercept: points.length > 0 ? points[0]!.y : 0 };
    }

    // Initial fit using standard WLS
    let { slope, intercept } = weightedLinearRegression(points);

    for (let iter = 0; iter < maxIter; iter++) {
        // Compute residuals
        const residuals = points.map(p => p.y - (slope * p.x + intercept));

        // MAD (median absolute deviation) of residuals
        const absRes = residuals.map(r => Math.abs(r));
        absRes.sort((a, b) => a - b);
        const mad = absRes[Math.floor(absRes.length / 2)]! || 1;
        const scale = Math.max(mad / 0.6745, 0.5); // 0.5h minimum scale

        // Tukey bisquare reweighting
        const reweighted = points.map((p, i) => {
            const u = residuals[i]! / (tuningConstant * scale);
            const bisquareW = Math.abs(u) <= 1 ? (1 - u * u) ** 2 : 0;
            return { x: p.x, y: p.y, w: p.w * bisquareW };
        });

        const activeCount = reweighted.filter(p => p.w > 1e-6).length;
        if (activeCount < 2) break;

        const newFit = weightedLinearRegression(reweighted);
        if (Math.abs(newFit.slope - slope) < 1e-6) break;

        slope = newFit.slope;
        intercept = newFit.intercept;
    }

    return { slope, intercept };
}

// ─── Gaussian kernel ───────────────────────────────────────────────

function gaussian(distance: number, sigma: number): number {
    return Math.exp(-0.5 * (distance / sigma) ** 2);
}

// ─── Sliding window evaluation ─────────────────────────────────────

function evaluateWindow(anchors: Anchor[], centerDay: number, halfWindow: number) {
    const points: { x: number; y: number; w: number }[] = [];
    let qualitySum = 0;
    let qualityCount = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const a of anchors) {
        const dist = Math.abs(a.dayNumber - centerDay);
        if (dist > halfWindow) continue;

        const wDist = gaussian(dist, GAUSSIAN_SIGMA);
        const w = a.weight * wDist;
        if (w < 1e-6) continue;

        points.push({ x: a.dayNumber, y: a.midpointHour, w });
        qualitySum += a.weight;
        qualityCount++;

        if (a.tier === "A") {
            durationSum += a.record.durationHours;
            durationCount++;
        }
    }

    if (points.length < 2) {
        return {
            slope: 0,
            intercept: 0,
            pointsUsed: points.length,
            avgQuality: 0,
            residualMAD: 999,
            avgDuration: 8
        };
    }

    const { slope, intercept } = robustWeightedRegression(points);

    // Compute residual MAD
    const residuals = points.map(p => Math.abs(p.y - (slope * p.x + intercept)));
    residuals.sort((a, b) => a - b);
    const residualMAD = residuals[Math.floor(residuals.length / 2)]!;

    return {
        slope,
        intercept,
        pointsUsed: points.length,
        avgQuality: qualityCount > 0 ? qualitySum / qualityCount : 0,
        residualMAD,
        avgDuration: durationCount > 0 ? durationSum / durationCount : 8
    };
}

// ─── Main analysis function ────────────────────────────────────────

/**
 * @param extraDays - Number of days to forecast beyond the data range (for circadian overlay prediction)
 */
export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): CircadianAnalysis {
    const empty: CircadianAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
        anchors: [],
        medianResidualHours: 0,
        anchorCount: 0,
        anchorTierCounts: { A: 0, B: 0, C: 0 },
        tau: 24,
        dailyDrift: 0,
        rSquared: 0
    };

    if (records.length === 0) return empty;

    // Step 1: Classify all records
    const candidates: AnchorCandidate[] = [];
    for (const record of records) {
        const c = classifyAnchor(record);
        if (c) candidates.push(c);
    }

    if (candidates.length < 2) return empty;

    const tierCounts = { A: 0, B: 0, C: 0 };
    for (const c of candidates) tierCounts[c.tier]++;

    // Step 2: Check if Tier C needed (max A+B gap > 14 days)
    const abDates = [...new Set(candidates.filter(c => c.tier !== "C").map(c => c.record.dateOfSleep))].sort();

    let maxGapAB = 0;
    for (let i = 1; i < abDates.length; i++) {
        const gap = Math.round((new Date(abDates[i]! + "T00:00:00").getTime() - new Date(abDates[i - 1]! + "T00:00:00").getTime()) / 86_400_000);
        maxGapAB = Math.max(maxGapAB, gap);
    }

    const activeCandidates = maxGapAB > 14 ? candidates : candidates.filter(c => c.tier !== "C");

    // Step 3: Build anchors sorted by date
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const firstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();
    const activeIds = new Set(activeCandidates.map(c => c.record.logId));
    const candMap = new Map(activeCandidates.map(c => [c.record.logId, c]));

    let anchors: Anchor[] = [];
    for (const record of sorted) {
        if (!activeIds.has(record.logId)) continue;
        const c = candMap.get(record.logId)!;
        anchors.push({
            dayNumber: Math.round((new Date(record.dateOfSleep + "T00:00:00").getTime() - firstDateMs) / 86_400_000),
            midpointHour: sleepMidpointHour(record, firstDateMs),
            weight: c.weight,
            tier: c.tier,
            record,
            date: record.dateOfSleep
        });
    }

    if (anchors.length < 2) return empty;

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
    const lastDay = Math.max(
        anchors[anchors.length - 1]!.dayNumber,
        Math.round((new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - firstDateMs) / 86_400_000)
    );

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
    let tauSum = 0;
    let tauWSum = 0;
    const allResiduals: number[] = [];

    const totalDays = lastDay + extraDays;

    // Compute edge fit for forecast extrapolation: freeze the regression
    // from the last data day so forecast days extrapolate smoothly instead
    // of re-evaluating a window that drifts away from real data.
    let edgeResult = evaluateWindow(anchors, lastDay, WINDOW_HALF);
    if (edgeResult.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
        edgeResult = evaluateWindow(anchors, lastDay, Math.round(WINDOW_HALF * 1.5));
        if (edgeResult.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
            edgeResult = evaluateWindow(anchors, lastDay, MAX_WINDOW_HALF);
        }
    }

    // Base confidence for the edge fit (used to compute decaying forecast confidence)
    const edgeExpected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
    const edgeBaseConf =
        0.4 * Math.min(1, edgeResult.pointsUsed / edgeExpected) + 0.3 * edgeResult.avgQuality + 0.3 * (1 - Math.min(1, edgeResult.residualMAD / 3));

    const firstDate = new Date(firstDateMs);
    for (let d = 0; d <= totalDays; d++) {
        const dayDate = new Date(firstDate);
        dayDate.setDate(firstDate.getDate() + d);
        const dateStr = dayDate.getFullYear() + "-" + String(dayDate.getMonth() + 1).padStart(2, "0") + "-" + String(dayDate.getDate()).padStart(2, "0");

        const isForecast = d > lastDay;
        let result;

        if (isForecast) {
            // Use frozen edge regression for smooth extrapolation
            result = edgeResult;
        } else {
            result = evaluateWindow(anchors, d, WINDOW_HALF);
            if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
                result = evaluateWindow(anchors, d, Math.round(WINDOW_HALF * 1.5));
                if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
                    result = evaluateWindow(anchors, d, MAX_WINDOW_HALF);
                }
            }
        }

        const predictedMid = result.slope * d + result.intercept;
        const localTau = 24 + result.slope;

        const normalizedMid = ((predictedMid % 24) + 24) % 24;
        const halfDur = result.avgDuration / 2;

        // Confidence
        let confScore: number;
        if (isForecast) {
            // Decay confidence with distance from last data day
            // ~0.5 at 7 days, ~0.25 at 14 days, ~0.05 at 30 days
            const distFromEdge = d - lastDay;
            confScore = edgeBaseConf * Math.exp(-0.1 * distFromEdge);
        } else {
            const expected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
            const density = Math.min(1, result.pointsUsed / expected);
            const quality = result.avgQuality;
            const spread = 1 - Math.min(1, result.residualMAD / 3);
            confScore = 0.4 * density + 0.3 * quality + 0.3 * spread;
        }

        days.push({
            date: dateStr,
            nightStartHour: normalizedMid - halfDur,
            nightEndHour: normalizedMid + halfDur,
            confidenceScore: confScore,
            confidence: confScore >= 0.6 ? "high" : confScore >= 0.3 ? "medium" : "low",
            localTau,
            localDrift: result.slope,
            anchorSleep: bestAnchorByDate.get(dateStr)?.record,
            isForecast
        });

        tauSum += localTau * confScore;
        tauWSum += confScore;

        // Collect residuals for stats (only for data days)
        if (!isForecast) {
            for (const a of anchors) {
                if (Math.abs(a.dayNumber - d) < 0.5) {
                    allResiduals.push(Math.abs(a.midpointHour - predictedMid));
                }
            }
        }
    }

    const globalTau = tauWSum > 0 ? tauSum / tauWSum : 24;
    const globalDrift = globalTau - 24;

    allResiduals.sort((a, b) => a - b);
    const medResidual = allResiduals.length > 0 ? allResiduals[Math.floor(allResiduals.length / 2)]! : 0;

    return {
        globalTau,
        globalDailyDrift: globalDrift,
        days,
        anchors: anchors.map(a => ({
            dayNumber: a.dayNumber,
            midpointHour: a.midpointHour,
            weight: a.weight,
            tier: a.tier,
            date: a.date
        })),
        medianResidualHours: medResidual,
        anchorCount: anchors.length,
        anchorTierCounts: tierCounts,
        tau: globalTau,
        dailyDrift: globalDrift,
        rSquared: 1 - Math.min(1, medResidual / 3)
    };
}

// ─── Helpers ───────────────────────────────────────────────────────

function computeMedianSpacing(anchors: Anchor[]): number {
    if (anchors.length < 2) return 7;
    const spacings: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
        spacings.push(anchors[i]!.dayNumber - anchors[i - 1]!.dayNumber);
    }
    spacings.sort((a, b) => a - b);
    return spacings[Math.floor(spacings.length / 2)]!;
}

/** @internal Exported for testing only. */
export const _internals = {
    classifyAnchor,
    sleepMidpointHour,
    localPairwiseUnwrap,
    findSeedRegion,
    weightedLinearRegression,
    robustWeightedRegression,
    gaussian,
    evaluateWindow,
    computeMedianSpacing,
    expandFromRegion,
    snapToNeighbors,
    unwrapAnchorsFromSeed,
};
