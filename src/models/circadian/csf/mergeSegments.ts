import type { CircadianDay } from "../types";
import type { CSFAnalysis, SegmentResult } from "./types";

export const ALGORITHM_ID = "csf-v1";

export function mergeSegmentResults(segments: SegmentResult[], globalFirstDateMs: number): CSFAnalysis {
    const empty: CSFAnalysis = {
        globalTau: 24,
        globalDailyDrift: 0,
        days: [],
        algorithmId: ALGORITHM_ID,
        tau: 24,
        dailyDrift: 0,
        rSquared: 0,
        states: [],
        anchorCount: 0,
        anchorTierCounts: { A: 0, B: 0, C: 0 },
    };

    if (segments.length === 0) return empty;

    segments.sort((a, b) => a.segFirstDay - b.segFirstDay);

    const allDays: CircadianDay[] = [];
    const allStates: SegmentResult["states"] = [];
    const allResiduals: number[] = [];
    const tierCounts = { A: 0, B: 0, C: 0 };
    let anchorCount = 0;

    const firstDate = new Date(globalFirstDateMs);

    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si]!;

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
        allStates.push(...seg.states);
        allResiduals.push(...seg.residuals);
        tierCounts.A += seg.tierCounts.A;
        tierCounts.B += seg.tierCounts.B;
        tierCounts.C += seg.tierCounts.C;
        anchorCount += seg.anchorCount;
    }

    const overlayMids: { x: number; y: number; w: number }[] = [];
    let prevMid = -Infinity;

    for (const day of allDays) {
        if (day.isForecast || day.isGap) continue;
        let mid = (day.nightStartHour + day.nightEndHour) / 2;

        if (prevMid > -Infinity) {
            while (mid - prevMid > 12) mid -= 24;
            while (prevMid - mid > 12) mid += 24;
        }

        const dayDate = new Date(day.date + "T00:00:00");
        const globalD = Math.round((dayDate.getTime() - globalFirstDateMs) / 86_400_000);
        overlayMids.push({ x: globalD, y: mid, w: day.confidenceScore });
        prevMid = mid;
    }

    let globalTau: number;
    if (overlayMids.length >= 2) {
        let sumW = 0,
            sumWX = 0,
            sumWY = 0,
            sumWXX = 0,
            sumWXY = 0;
        for (const p of overlayMids) {
            sumW += p.w;
            sumWX += p.w * p.x;
            sumWY += p.w * p.y;
            sumWXX += p.w * p.x * p.x;
            sumWXY += p.w * p.x * p.y;
        }
        const denom = sumW * sumWXX - sumWX * sumWX;
        if (denom !== 0 && sumW !== 0) {
            const slope = (sumW * sumWXY - sumWX * sumWY) / denom;
            globalTau = 24 + slope;
        } else {
            globalTau = 24;
        }
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
        algorithmId: ALGORITHM_ID,
        tau: globalTau,
        dailyDrift: globalDrift,
        rSquared: 1 - Math.min(1, medResidual / 3),
        states: allStates,
        anchorCount,
        anchorTierCounts: tierCounts,
    };
}
