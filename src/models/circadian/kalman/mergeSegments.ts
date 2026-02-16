// Merge independently-analyzed Kalman segments into a single KalmanAnalysis result
import type { CircadianDay } from "../types";
import type { KalmanAnalysis } from "./types";
import type { KalmanSegmentResult } from "./analyzeSegment";

export const ALGORITHM_ID = "kalman-v1";

export function mergeSegmentResults(
    segments: KalmanSegmentResult[],
    globalFirstDateMs: number,
): KalmanAnalysis {
    const empty: KalmanAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
        algorithmId: ALGORITHM_ID,
        tau: 24,
        dailyDrift: 0,
        rSquared: 0,
        gatedOutlierCount: 0,
        observationCount: 0,
        avgInnovation: 0,
    };

    if (segments.length === 0) return empty;

    segments.sort((a, b) => a.segFirstDay - b.segFirstDay);

    const allDays: CircadianDay[] = [];
    let totalGated = 0;
    let totalObs = 0;
    let innovationSum = 0;

    const firstDate = new Date(globalFirstDateMs);

    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!;

        // Fill gap days between segments
        if (si > 0) {
            const prevEnd = segments[si - 1]!.segLastDay;
            for (let d = prevEnd + 1; d < seg.segFirstDay; d++) {
                const dayDate = new Date(firstDate);
                dayDate.setDate(firstDate.getDate() + d);
                const dateStr =
                    dayDate.getFullYear() +
                    "-" +
                    String(dayDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(dayDate.getDate()).padStart(2, "0");
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
        totalGated += seg.gatedCount;
        totalObs += seg.observationCount;
        innovationSum += seg.innovationSum * seg.observationCount;
    }

    // Compute global tau from overlay midpoints via weighted regression
    const overlayMids: { x: number; y: number; w: number }[] = [];
    let prevMid = -Infinity;

    for (const seg of segments) {
        for (const day of seg.days) {
            if (day.isForecast || day.isGap) continue;
            let mid = (day.nightStartHour + day.nightEndHour) / 2;

            // Unwrap for continuity
            if (prevMid > -Infinity) {
                while (mid - prevMid > 12) mid -= 24;
                while (prevMid - mid > 12) mid += 24;
            }

            const dayDate = new Date(day.date + "T00:00:00");
            const globalD = Math.round((dayDate.getTime() - globalFirstDateMs) / 86_400_000);
            overlayMids.push({ x: globalD, y: mid, w: day.confidenceScore });
            prevMid = mid;
        }
    }

    let globalTau = 24;
    let rSquared = 0;

    if (overlayMids.length >= 2) {
        // Weighted linear regression for global tau
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (const p of overlayMids) {
            sw += p.w;
            sx += p.w * p.x;
            sy += p.w * p.y;
            sxx += p.w * p.x * p.x;
            sxy += p.w * p.x * p.y;
        }
        const denom = sw * sxx - sx * sx;
        if (Math.abs(denom) > 1e-10) {
            const slope = (sw * sxy - sx * sy) / denom;
            const intercept = (sy * sxx - sx * sxy) / denom;
            globalTau = 24 + slope;

            // R² from residuals
            let ssRes = 0, ssTot = 0;
            const yMean = sy / sw;
            for (const p of overlayMids) {
                const pred = slope * p.x + intercept;
                ssRes += p.w * (p.y - pred) ** 2;
                ssTot += p.w * (p.y - yMean) ** 2;
            }
            rSquared = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
        }
    }

    const globalDrift = globalTau - 24;
    const avgInnovation = totalObs > 0 ? innovationSum / totalObs : 0;

    return {
        globalTau,
        globalDailyDrift: globalDrift,
        days: allDays,
        algorithmId: ALGORITHM_ID,
        tau: globalTau,
        dailyDrift: globalDrift,
        rSquared,
        gatedOutlierCount: totalGated,
        observationCount: totalObs,
        avgInnovation,
    };
}
