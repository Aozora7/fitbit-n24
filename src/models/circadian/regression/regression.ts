// Weighted linear regression, robust regression (IRLS), Gaussian kernel, and sliding window evaluation
import type { Anchor } from "./types";
import { WINDOW_HALF, MAX_WINDOW_HALF, MIN_ANCHORS_PER_WINDOW, GAUSSIAN_SIGMA } from "./types";

export function weightedLinearRegression(points: { x: number; y: number; w: number }[]): {
    slope: number;
    intercept: number;
} {
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
        intercept: (sumWY * sumWXX - sumWX * sumWXY) / denom,
    };
}

export function robustWeightedRegression(
    points: { x: number; y: number; w: number }[],
    maxIter = 5,
    tuningConstant = 4.685
): { slope: number; intercept: number } {
    if (points.length < 2) {
        return { slope: 0, intercept: points.length > 0 ? points[0]!.y : 0 };
    }

    let { slope, intercept } = weightedLinearRegression(points);

    for (let iter = 0; iter < maxIter; iter++) {
        const residuals = points.map((p) => p.y - (slope * p.x + intercept));

        const absRes = residuals.map((r) => Math.abs(r));
        absRes.sort((a, b) => a - b);
        const mad = absRes[Math.floor(absRes.length / 2)]! || 1;
        const scale = Math.max(mad / 0.6745, 0.5);

        const reweighted = points.map((p, i) => {
            const u = residuals[i]! / (tuningConstant * scale);
            const bisquareW = Math.abs(u) <= 1 ? (1 - u * u) ** 2 : 0;
            return { x: p.x, y: p.y, w: p.w * bisquareW };
        });

        const activeCount = reweighted.filter((p) => p.w > 1e-6).length;
        if (activeCount < 2) break;

        const newFit = weightedLinearRegression(reweighted);
        if (Math.abs(newFit.slope - slope) < 1e-6) break;

        slope = newFit.slope;
        intercept = newFit.intercept;
    }

    return { slope, intercept };
}

export function gaussian(distance: number, sigma: number): number {
    return Math.exp(-0.5 * (distance / sigma) ** 2);
}

export interface WindowResult {
    slope: number;
    intercept: number;
    pointsUsed: number;
    avgQuality: number;
    residualMAD: number;
    avgDuration: number;
    weightedMeanX: number;
}

export function evaluateWindow(
    anchors: Anchor[],
    centerDay: number,
    halfWindow: number,
    sigma: number = GAUSSIAN_SIGMA
): WindowResult {
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

        durationSum += a.record.durationHours * a.weight;
        durationCount += a.weight;
    }

    let wxSum = 0,
        wSumX = 0;
    for (const p of points) {
        wxSum += p.w * p.x;
        wSumX += p.w;
    }
    const weightedMeanX = wSumX > 0 ? wxSum / wSumX : centerDay;

    if (points.length < 2) {
        return {
            slope: 0,
            intercept: 0,
            pointsUsed: points.length,
            avgQuality: 0,
            residualMAD: 999,
            avgDuration: 8,
            weightedMeanX,
        };
    }

    const { slope, intercept } = robustWeightedRegression(points);

    const residuals = points.map((p) => Math.abs(p.y - (slope * p.x + intercept)));
    residuals.sort((a, b) => a - b);
    const residualMAD = residuals[Math.floor(residuals.length / 2)]!;

    return {
        slope,
        intercept,
        pointsUsed: points.length,
        avgQuality: qualityCount > 0 ? qualitySum / qualityCount : 0,
        residualMAD,
        avgDuration: durationCount > 0 ? durationSum / durationCount : 8,
        weightedMeanX,
    };
}

export function evaluateWindowExpanding(anchors: Anchor[], centerDay: number): WindowResult {
    let result = evaluateWindow(anchors, centerDay, WINDOW_HALF);
    if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
        result = evaluateWindow(anchors, centerDay, Math.round(WINDOW_HALF * 1.5));
        if (result.pointsUsed < MIN_ANCHORS_PER_WINDOW) {
            result = evaluateWindow(anchors, centerDay, MAX_WINDOW_HALF);
        }
    }
    return result;
}
