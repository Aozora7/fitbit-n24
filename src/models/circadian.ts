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
}

export interface CircadianAnalysis {
    globalTau: number;
    globalDailyDrift: number;
    days: CircadianDay[];
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

const WINDOW_HALF = 45; // 90-day window
const MAX_WINDOW_HALF = 90; // expand to 180 days if sparse
const MIN_ANCHORS_PER_WINDOW = 8;
const GAUSSIAN_SIGMA = 30; // half-weight at 30 days from center
const OUTLIER_THRESHOLD_HOURS = 4;

// ─── Sleep quality score ───────────────────────────────────────────

export function computeQualityScore(record: SleepRecord): number {
    if (record.stages) {
        const { deep, light, rem, wake } = record.stages;
        const sleepMinutes = deep + light + rem;
        if (sleepMinutes === 0) return 0;

        const remPercent = (rem / sleepMinutes) * 100;
        const remScore = Math.min(1, remPercent / 25);
        const deepScore = Math.min(1, deep / 60);
        const wakeScore = 1 - Math.min(1, wake / 60);

        return 0.5 * remScore + 0.25 * deepScore + 0.25 * wakeScore;
    }

    // v1 fallback: use efficiency, capped at 0.7
    return (record.efficiency / 100) * 0.7;
}

// ─── Anchor classification ─────────────────────────────────────────

interface AnchorCandidate {
    record: SleepRecord;
    quality: number;
    tier: AnchorTier;
    weight: number;
}

function classifyAnchor(record: SleepRecord): AnchorCandidate | null {
    const quality = computeQualityScore(record);
    const dur = record.durationHours;

    let tier: AnchorTier;
    let baseWeight: number;

    if (dur >= 7 && quality >= 0.5) {
        tier = "A";
        baseWeight = 1.0;
    } else if (dur >= 5 && quality >= 0.3) {
        tier = "B";
        baseWeight = 0.4;
    } else if (dur >= 4 && quality >= 0.2) {
        tier = "C";
        baseWeight = 0.1;
    } else {
        return null;
    }

    const durFactor = Math.min(1, (dur - 4) / 5);
    const weight = baseWeight * quality * durFactor;

    return { record, quality, tier, weight };
}

// ─── Midpoint computation ──────────────────────────────────────────

/** Compute midpoint as absolute hours from a fixed epoch (firstDateMs) */
function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

// ─── Unwrapping ────────────────────────────────────────────────────

function unwrapAnchors(anchors: Anchor[]): void {
    // Midpoints are absolute hours from epoch, so they should be
    // monotonically increasing for free-running N24. Handle jumps
    // from mislabeled dateOfSleep or forced sleeps.
    for (let i = 1; i < anchors.length; i++) {
        const prev = anchors[i - 1]!.midpointHour;
        let curr = anchors[i]!.midpointHour;

        while (curr - prev > 12) curr -= 24;
        while (prev - curr > 12) curr += 24;

        anchors[i]!.midpointHour = curr;
    }
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

    const { slope, intercept } = weightedLinearRegression(points);

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
export function analyzeCircadian(records: SleepRecord[], extraDays = 0): CircadianAnalysis {
    const empty: CircadianAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
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
        const gap = (new Date(abDates[i]! + "T00:00:00").getTime() - new Date(abDates[i - 1]! + "T00:00:00").getTime()) / 86_400_000;
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
            dayNumber: (new Date(record.dateOfSleep + "T00:00:00").getTime() - firstDateMs) / 86_400_000,
            midpointHour: sleepMidpointHour(record, firstDateMs),
            weight: c.weight,
            tier: c.tier,
            record,
            date: record.dateOfSleep
        });
    }

    if (anchors.length < 2) return empty;

    // Step 4: Unwrap
    unwrapAnchors(anchors);

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

    if (outliers.size > 0 && outliers.size < anchors.length * 0.3) {
        anchors = anchors.filter((_, i) => !outliers.has(i));
        unwrapAnchors(anchors);
    }

    // Step 6: Per-day sliding window
    const lastDay = Math.max(
        anchors[anchors.length - 1]!.dayNumber,
        (new Date(sorted[sorted.length - 1]!.dateOfSleep + "T00:00:00").getTime() - firstDateMs) / 86_400_000
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

    for (let d = 0; d <= totalDays; d++) {
        const dayDate = new Date(firstDateMs + d * 86_400_000);
        const dateStr = dayDate.getFullYear() + "-" + String(dayDate.getMonth() + 1).padStart(2, "0") + "-" + String(dayDate.getDate()).padStart(2, "0");

        let result = evaluateWindow(anchors, d, WINDOW_HALF);
        if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
            result = evaluateWindow(anchors, d, MAX_WINDOW_HALF);
        }

        const predictedMid = result.slope * d + result.intercept;
        const localTau = 24 + result.slope;

        const normalizedMid = ((predictedMid % 24) + 24) % 24;
        const halfDur = result.avgDuration / 2;

        // Confidence
        const expected = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
        const density = Math.min(1, result.pointsUsed / expected);
        const quality = result.avgQuality;
        const spread = 1 - Math.min(1, result.residualMAD / 3);
        const confScore = 0.4 * density + 0.3 * quality + 0.3 * spread;

        days.push({
            date: dateStr,
            nightStartHour: normalizedMid - halfDur,
            nightEndHour: normalizedMid + halfDur,
            confidenceScore: confScore,
            confidence: confScore >= 0.6 ? "high" : confScore >= 0.3 ? "medium" : "low",
            localTau,
            localDrift: result.slope,
            anchorSleep: bestAnchorByDate.get(dateStr)?.record
        });

        tauSum += localTau * confScore;
        tauWSum += confScore;

        // Collect residuals for stats
        for (const a of anchors) {
            if (Math.abs(a.dayNumber - d) < 0.5) {
                allResiduals.push(Math.abs(a.midpointHour - predictedMid));
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
