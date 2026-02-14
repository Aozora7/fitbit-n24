// Merge independently-analyzed segments into a single CircadianAnalysis result
import type { CircadianAnalysis, CircadianDay, AnchorPoint, SegmentResult } from "./types";
import { weightedLinearRegression } from "./regression";

export function mergeSegmentResults(
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
