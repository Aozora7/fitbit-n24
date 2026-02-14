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
    isGap: boolean;
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
const REGULARIZATION_HALF = 60; // half-width for regional slope fallback (120-day window; responsive to transitions)
const SMOOTH_HALF = 7; // post-hoc smoothing: ±7 day neighborhood
const SMOOTH_SIGMA = 3; // Gaussian sigma for smoothing weights
const SMOOTH_JUMP_THRESH = 2; // only smooth days with >2h jump to neighbor
const GAP_THRESHOLD_DAYS = 14; // suppress overlay when nearest sleep record is ≥14 days away

// ─── Segment splitting ────────────────────────────────────────────

/** Split sorted records into independent segments at data gaps > GAP_THRESHOLD_DAYS */
function splitIntoSegments(records: SleepRecord[]): SleepRecord[][] {
    if (records.length === 0) return [];
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const segments: SleepRecord[][] = [[sorted[0]!]];
    let latestDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    for (let i = 1; i < sorted.length; i++) {
        const currDateMs = new Date(sorted[i]!.dateOfSleep + "T00:00:00").getTime();
        const gapDays = Math.round((currDateMs - latestDateMs) / 86_400_000);
        if (gapDays > GAP_THRESHOLD_DAYS) {
            segments.push([sorted[i]!]);
        } else {
            segments[segments.length - 1]!.push(sorted[i]!);
        }
        latestDateMs = Math.max(latestDateMs, currDateMs);
    }
    return segments;
}

// ─── Segment result type ──────────────────────────────────────────

interface SegmentResult {
    days: CircadianDay[];
    anchors: AnchorPoint[];
    tierCounts: { A: number; B: number; C: number };
    anchorCount: number;
    residuals: number[];
    segFirstDay: number; // global day number of segment's first record
    segLastDay: number;  // global day number of segment's last data day
}

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

/** Snap anchor[i] to within 12h of prediction from already-unwrapped neighbors.
 *  Uses both regression-based and nearest-neighbor (pairwise) predictions.
 *  When they agree on the 24h branch, uses regression (more informed).
 *  When they disagree and the nearest neighbor is close, prefers pairwise
 *  to avoid regression overextrapolation during fragmented periods. */
function snapToNeighbors(anchors: Anchor[], idx: number, refStart: number, refEnd: number): void {
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

function evaluateWindow(anchors: Anchor[], centerDay: number, halfWindow: number, sigma: number = GAUSSIAN_SIGMA) {
    const points: { x: number; y: number; w: number }[] = [];
    let qualitySum = 0;
    let qualityCount = 0;
    let durationSum = 0;
    let durationCount = 0;

    for (const a of anchors) {
        const dist = Math.abs(a.dayNumber - centerDay);
        if (dist > halfWindow) continue;

        const wDist = gaussian(dist, sigma);
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

    // Compute weighted mean x (centroid) for regularized extrapolation
    let wxSum = 0, wSumX = 0;
    for (const p of points) { wxSum += p.w * p.x; wSumX += p.w; }
    const weightedMeanX = wSumX > 0 ? wxSum / wSumX : centerDay;

    if (points.length < 2) {
        return {
            slope: 0,
            intercept: 0,
            pointsUsed: points.length,
            avgQuality: 0,
            residualMAD: 999,
            avgDuration: 8,
            weightedMeanX
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
        avgDuration: durationCount > 0 ? durationSum / durationCount : 8,
        weightedMeanX
    };
}

// ─── Segment analysis pipeline ─────────────────────────────────────

/**
 * Analyze a single contiguous segment of sleep records.
 * @param records - Records within this segment (no gaps > GAP_THRESHOLD_DAYS)
 * @param extraDays - Forecast days to append (only for the last segment)
 * @param globalFirstDateMs - Epoch of the first record across all segments (for consistent day numbering)
 */
function analyzeSegment(records: SleepRecord[], extraDays: number, globalFirstDateMs: number): SegmentResult | null {
    if (records.length === 0) return null;

    // Step 1: Classify all records
    const candidates: AnchorCandidate[] = [];
    for (const record of records) {
        const c = classifyAnchor(record);
        if (c) candidates.push(c);
    }

    if (candidates.length < 2) return null;

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

    // Step 3: Build anchors sorted by date (using global epoch for day numbers)
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const activeIds = new Set(activeCandidates.map(c => c.record.logId));
    const candMap = new Map(activeCandidates.map(c => [c.record.logId, c]));

    let anchors: Anchor[] = [];
    for (const record of sorted) {
        if (!activeIds.has(record.logId)) continue;
        const c = candMap.get(record.logId)!;
        anchors.push({
            dayNumber: Math.round((new Date(record.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000),
            midpointHour: sleepMidpointHour(record, globalFirstDateMs),
            weight: c.weight,
            tier: c.tier,
            record,
            date: record.dateOfSleep
        });
    }

    if (anchors.length < 2) return null;

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
    const segFirstDay = Math.round((new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000);
    const segLastDay = Math.max(
        anchors[anchors.length - 1]!.dayNumber,
        Math.round((new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000)
    );
    const localDataDays = segLastDay - segFirstDay; // local index of last data day
    const localTotalDays = localDataDays + extraDays;

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
    const allResiduals: number[] = [];

    // Parallel arrays for post-hoc smoothing (local 0-based indexing)
    const rawPredictedMid: number[] = [];
    const rawConfScore: number[] = [];
    const rawIsForecast: boolean[] = [];
    const rawSlopeConf: number[] = [];
    const rawHalfDur: number[] = [];

    // Compute edge fit for forecast extrapolation: freeze the regression
    // from the last data day so forecast days extrapolate smoothly instead
    // of re-evaluating a window that drifts away from real data.
    let edgeResult = evaluateWindow(anchors, segLastDay, WINDOW_HALF);
    if (edgeResult.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
        edgeResult = evaluateWindow(anchors, segLastDay, Math.round(WINDOW_HALF * 1.5));
        if (edgeResult.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
            edgeResult = evaluateWindow(anchors, segLastDay, MAX_WINDOW_HALF);
        }
    }

    // Base confidence for the edge fit (used to compute decaying forecast confidence)
    const edgeExpected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
    const edgeBaseConf =
        0.4 * Math.min(1, edgeResult.pointsUsed / edgeExpected) + 0.3 * edgeResult.avgQuality + 0.3 * (1 - Math.min(1, edgeResult.residualMAD / 3));

    const firstDate = new Date(globalFirstDateMs);
    for (let localD = 0; localD <= localTotalDays; localD++) {
        const globalD = segFirstDay + localD;
        const dayDate = new Date(firstDate);
        dayDate.setDate(firstDate.getDate() + globalD);
        const dateStr = dayDate.getFullYear() + "-" + String(dayDate.getMonth() + 1).padStart(2, "0") + "-" + String(dayDate.getDate()).padStart(2, "0");

        const isForecast = localD > localDataDays;
        let result;

        if (isForecast) {
            result = edgeResult;
        } else {
            result = evaluateWindow(anchors, globalD, WINDOW_HALF);
            if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
                result = evaluateWindow(anchors, globalD, Math.round(WINDOW_HALF * 1.5));
                if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
                    result = evaluateWindow(anchors, globalD, MAX_WINDOW_HALF);
                }
            }
        }

        const expectedPts = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
        let slopeConf = Math.min(1, result.pointsUsed / expectedPts) *
                        (1 - Math.min(1, result.residualMAD / 4));

        // Regime change detection: when local slope differs significantly from
        // regional slope, trust the local window more to prevent blending across
        // regime boundaries (e.g., short entrained periods surrounded by N24).
        const regionalFit = evaluateWindow(anchors, globalD, REGULARIZATION_HALF);
        const useRegional = regionalFit.pointsUsed >= MIN_ANCHORS_PER_WINDOW &&
                            regionalFit.slope >= -0.5 && regionalFit.slope <= 2.0;
        const fallbackSlope = useRegional ? regionalFit.slope : globalFit.slope;

        // Detect potential regime change: if local and regional slopes differ by > 0.3h/day
        // and local window has sufficient anchors, increase confidence in local slope
        const slopeDiff = Math.abs(result.slope - fallbackSlope);
        const REGIME_CHANGE_THRESHOLD = 0.3; // 0.3h/day ≈ τ difference of 0.3h
        if (slopeDiff > REGIME_CHANGE_THRESHOLD && result.pointsUsed >= MIN_ANCHORS_PER_WINDOW && result.residualMAD < 2.0) {
            // Boost local confidence to prevent blending across regime boundaries
            // Scale boost by how different the slopes are (more different = more boost)
            const boost = Math.min(0.4, (slopeDiff - REGIME_CHANGE_THRESHOLD) * 0.5);
            slopeConf = Math.min(1, slopeConf + boost);
        }

        let regularizedSlope = slopeConf * result.slope + (1 - slopeConf) * fallbackSlope;

        // Safety cap: extreme slopes (>2.0 h/day = tau > 26h) are almost always
        // estimation errors during fragmentation. Fall back to regional slope.
        if (regularizedSlope > 2.0 || regularizedSlope < -0.5) {
            regularizedSlope = fallbackSlope;
        }

        // Clamp to non-negative: the circadian clock doesn't run backward (tau < 24h).
        // Slightly negative regularized slopes arise from noisy fragmented data pulling
        // the local regression negative even after regularization toward regional slope.
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

    return {
        days,
        anchors: anchors.map(a => ({
            dayNumber: a.dayNumber,
            midpointHour: a.midpointHour,
            weight: a.weight,
            tier: a.tier,
            date: a.date
        })),
        tierCounts,
        anchorCount: anchors.length,
        residuals: allResiduals,
        segFirstDay,
        segLastDay,
    };
}

// ─── Segment merging ──────────────────────────────────────────────

function mergeSegmentResults(
    segments: SegmentResult[],
    globalFirstDateMs: number,
): CircadianAnalysis {
    const empty: CircadianAnalysis = {
        globalTau: 24, globalDailyDrift: 0, days: [], anchors: [],
        medianResidualHours: 0, anchorCount: 0, anchorTierCounts: { A: 0, B: 0, C: 0 },
        tau: 24, dailyDrift: 0, rSquared: 0
    };

    if (segments.length === 0) return empty;

    segments.sort((a, b) => a.segFirstDay - b.segFirstDay);

    const allDays: CircadianDay[] = [];
    const allAnchors: AnchorPoint[] = [];
    const allResiduals: number[] = [];
    const tierCounts = { A: 0, B: 0, C: 0 };
    let anchorCount = 0;

    const firstDate = new Date(globalFirstDateMs);

    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!;

        // Fill gap days before this segment (after previous segment)
        if (si > 0) {
            const prevEnd = segments[si - 1]!.segLastDay;
            for (let d = prevEnd + 1; d < seg.segFirstDay; d++) {
                const dayDate = new Date(firstDate);
                dayDate.setDate(firstDate.getDate() + d);
                const dateStr = dayDate.getFullYear() + "-" + String(dayDate.getMonth() + 1).padStart(2, "0") + "-" + String(dayDate.getDate()).padStart(2, "0");
                allDays.push({
                    date: dateStr,
                    nightStartHour: 0,
                    nightEndHour: 0,
                    confidenceScore: 0,
                    confidence: "low",
                    localTau: 24,
                    localDrift: 0,
                    isForecast: false,
                    isGap: true,
                });
            }
        }

        allDays.push(...seg.days);
        allAnchors.push(...seg.anchors);
        allResiduals.push(...seg.residuals);
        tierCounts.A += seg.tierCounts.A;
        tierCounts.B += seg.tierCounts.B;
        tierCounts.C += seg.tierCounts.C;
        anchorCount += seg.anchorCount;
    }

    // Compute globalTau from overlay midpoints, unwrapping per-segment
    // then bridging across gaps to maintain a continuous phase sequence.
    const overlayMids: { x: number; y: number; w: number }[] = [];
    let prevSegEndMid = -Infinity;

    for (const seg of segments) {
        let prevMid = -Infinity;

        for (const day of seg.days) {
            if (day.isForecast || day.isGap) continue;
            let mid = (day.nightStartHour + day.nightEndHour) / 2;

            if (prevMid > -Infinity) {
                while (mid - prevMid > 12) mid -= 24;
                while (prevMid - mid > 12) mid += 24;
            } else if (prevSegEndMid > -Infinity) {
                // Bridge between segments: snap to within 12h of previous segment's end
                while (mid - prevSegEndMid > 12) mid -= 24;
                while (prevSegEndMid - mid > 12) mid += 24;
            }

            const dayDate = new Date(day.date + "T00:00:00");
            const globalD = Math.round((dayDate.getTime() - globalFirstDateMs) / 86_400_000);
            overlayMids.push({ x: globalD, y: mid, w: day.confidenceScore });
            prevMid = mid;
        }

        if (prevMid > -Infinity) prevSegEndMid = prevMid;
    }

    let globalTau: number;
    if (overlayMids.length >= 2) {
        const overlayFit = weightedLinearRegression(overlayMids);
        globalTau = 24 + overlayFit.slope;
    } else {
        globalTau = 24;
    }
    const globalDrift = globalTau - 24;

    allResiduals.sort((a, b) => a - b);
    const medResidual = allResiduals.length > 0 ? allResiduals[Math.floor(allResiduals.length / 2)]! : 0;

    return {
        globalTau,
        globalDailyDrift: globalDrift,
        days: allDays,
        anchors: allAnchors,
        medianResidualHours: medResidual,
        anchorCount,
        anchorTierCounts: tierCounts,
        tau: globalTau,
        dailyDrift: globalDrift,
        rSquared: 1 - Math.min(1, medResidual / 3)
    };
}

// ─── Main analysis function ────────────────────────────────────────

/**
 * Orchestrator: splits records into independent segments at data gaps,
 * analyzes each segment with the full pipeline, and merges results.
 * @param extraDays - Number of days to forecast beyond the data range
 */
export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): CircadianAnalysis {
    const empty: CircadianAnalysis = {
        globalTau: 24, globalDailyDrift: 0, days: [], anchors: [],
        medianResidualHours: 0, anchorCount: 0, anchorTierCounts: { A: 0, B: 0, C: 0 },
        tau: 24, dailyDrift: 0, rSquared: 0
    };

    if (records.length === 0) return empty;

    // Sort all records and compute global epoch
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const globalFirstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    // Split into independent segments at data gaps > GAP_THRESHOLD_DAYS
    const recordSegments = splitIntoSegments(sorted);

    // Analyze each segment independently
    const segmentResults: SegmentResult[] = [];
    for (let i = 0; i < recordSegments.length; i++) {
        const isLast = i === recordSegments.length - 1;
        const result = analyzeSegment(recordSegments[i]!, isLast ? extraDays : 0, globalFirstDateMs);
        if (result) segmentResults.push(result);
    }

    if (segmentResults.length === 0) return empty;

    return mergeSegmentResults(segmentResults, globalFirstDateMs);
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
    GAP_THRESHOLD_DAYS,
    splitIntoSegments,
};
