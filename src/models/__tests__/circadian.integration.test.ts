import { describe, it, expect } from "vitest";
import { listAlgorithms, analyzeWithAlgorithm } from "../circadian";

import { generateSyntheticRecords } from "./fixtures/synthetic";
import { maybeSaveViz } from "./fixtures/visualize";

const algorithms = listAlgorithms();

// ── Algorithm-agnostic tests (run on all algorithms) ─────────────────

for (const algo of algorithms) {
    describe(`${algo.name} (${algo.id}) — synthetic data`, () => {
        const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
            analyzeWithAlgorithm(algo.id, records, extraDays);

        it("detects tau=24.0 within ±0.1h", () => {
            const records = generateSyntheticRecords({ tau: 24.0, days: 120, noise: 0.3, seed: 1 });
            const result = analyze(records);
            expect(result.globalTau).toBeCloseTo(24.0, 0);
            expect(Math.abs(result.globalTau - 24.0)).toBeLessThan(0.1);
        });

        it("detects tau=24.5 within ±0.1h", () => {
            const opts = { tau: 24.5, days: 120, noise: 0.3, seed: 2 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);
            maybeSaveViz(`integration_tau-24.5_${algo.id}`, {
                title: `Tau detection τ=24.5 — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.1);
        });

        it("detects tau=25.0 within ±0.15h", () => {
            const records = generateSyntheticRecords({ tau: 25.0, days: 120, noise: 0.3, seed: 3 });
            const result = analyze(records);
            expect(Math.abs(result.globalTau - 25.0)).toBeLessThan(0.15);
        });

        it("handles noisy data within ±0.5h", () => {
            const opts = { tau: 24.5, days: 150, noise: 1.5, seed: 4 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);
            maybeSaveViz(`integration_noisy_${algo.id}`, {
                title: `Noisy data (σ=1.5h) — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.5);
        });

        it("tolerates 30% gaps", () => {
            const opts = {
                tau: 24.5,
                days: 150,
                noise: 0.5,
                gapFraction: 0.3,
                seed: 5,
            };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);
            maybeSaveViz(`integration_gaps-30pct_${algo.id}`, {
                title: `30% gaps — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.3);
        });

        it("returns sane defaults for empty input", () => {
            const result = analyze([]);
            expect(result.globalTau).toBe(24);
            expect(result.days).toHaveLength(0);
        });

        it("returns sane defaults for single record", () => {
            const records = generateSyntheticRecords({ days: 1 });
            const result = analyze(records);
            expect(result.globalTau).toBe(24);
        });

        it("produces forecast days with extraDays parameter", () => {
            const records = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 6 });
            const noForecast = analyze(records, 0);
            const withForecast = analyze(records, 14);
            expect(withForecast.days.length).toBe(noForecast.days.length + 14);
            // Last 14 days should be marked as forecast
            const forecastDays = withForecast.days.filter((d) => d.isForecast);
            expect(forecastDays.length).toBe(14);
        });

        it("forecast confidence decays over time", () => {
            const records = generateSyntheticRecords({ tau: 24.5, days: 90, seed: 7 });
            const result = analyze(records, 30);
            const forecasts = result.days.filter((d) => d.isForecast);
            expect(forecasts.length).toBe(30);
            // First forecast day should have higher confidence than last
            expect(forecasts[0]!.confidenceScore).toBeGreaterThan(forecasts[forecasts.length - 1]!.confidenceScore);
        });
    });

    // ── Locality of tau estimation ──────────────────────────────────

    describe(`${algo.name} (${algo.id}) — locality of tau estimation`, () => {
        const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
            analyzeWithAlgorithm(algo.id, records, extraDays);

        it("distant historical data does not pull local tau at end of dataset", () => {
            const records = generateSyntheticRecords({
                tauSegments: [
                    { untilDay: 300, tau: 24.5 },
                    { untilDay: 420, tau: 25.15 },
                ],
                days: 420,
                noise: 0.3,
                seed: 100,
            });

            const fullResult = analyze(records);
            const lastDay = fullResult.days[fullResult.days.length - 1]!;

            expect(lastDay.localTau).toBeGreaterThan(24.9);
            expect(Math.abs(lastDay.localTau - 25.15)).toBeLessThan(0.3);
        });

        it("recent-only subset matches local tau from full dataset", () => {
            const allRecords = generateSyntheticRecords({
                tauSegments: [
                    { untilDay: 300, tau: 24.5 },
                    { untilDay: 420, tau: 25.15 },
                ],
                days: 420,
                noise: 0.3,
                seed: 100,
            });

            const recentRecords = allRecords.filter((r) => {
                const dayNum = Math.round((r.startTime.getTime() - allRecords[0]!.startTime.getTime()) / 86_400_000);
                return dayNum >= 330;
            });

            const fullResult = analyze(allRecords);
            const recentResult = analyze(recentRecords);

            const fullLastDay = fullResult.days[fullResult.days.length - 1]!;
            const recentLastDay = recentResult.days[recentResult.days.length - 1]!;

            expect(Math.abs(fullLastDay.localTau - recentLastDay.localTau)).toBeLessThan(0.25);
        });
    });

    // ── Data gap handling ───────────────────────────────────────────

    describe(`${algo.name} (${algo.id}) — data gap handling`, () => {
        const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
            analyzeWithAlgorithm(algo.id, records, extraDays);

        it("marks days in a 30-day gap as isGap", () => {
            const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 200 });
            const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 201, startMidpoint: 3 });

            const offsetMs = 90 * 86_400_000;
            const baseTime = before[0]!.startTime.getTime();
            const shiftedAfter = after.map((r) => {
                const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
                const newStart = new Date(baseTime + offsetMs + dayOffset);
                const newEnd = new Date(newStart.getTime() + r.durationMs);
                const newDate = new Date(baseTime + offsetMs + dayOffset);
                newDate.setHours(0, 0, 0, 0);
                const dateStr =
                    newDate.getFullYear() +
                    "-" +
                    String(newDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(newDate.getDate()).padStart(2, "0");
                return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
            });

            const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            const result = analyze(records);

            const gapDays = result.days.filter((d) => d.isGap);
            expect(gapDays.length).toBeGreaterThanOrEqual(28);
            expect(gapDays.length).toBeLessThanOrEqual(31);

            const dataDays = result.days.filter((d) => !d.isGap && !d.isForecast);
            expect(dataDays.length).toBeGreaterThan(100);
        });

        it("does not mark days in a 10-day gap as isGap (below threshold)", () => {
            const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 210 });
            const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 211 });

            const offsetMs = 70 * 86_400_000;
            const baseTime = before[0]!.startTime.getTime();
            const shiftedAfter = after.map((r) => {
                const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
                const newStart = new Date(baseTime + offsetMs + dayOffset);
                const newEnd = new Date(newStart.getTime() + r.durationMs);
                const newDate = new Date(baseTime + offsetMs + dayOffset);
                newDate.setHours(0, 0, 0, 0);
                const dateStr =
                    newDate.getFullYear() +
                    "-" +
                    String(newDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(newDate.getDate()).padStart(2, "0");
                return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
            });

            const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            const result = analyze(records);

            const gapDays = result.days.filter((d) => d.isGap);
            expect(gapDays.length).toBe(0);
        });

        it("gap boundary days have correct isGap values", () => {
            const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 220 });
            const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 221 });

            const offsetMs = 100 * 86_400_000;
            const baseTime = before[0]!.startTime.getTime();
            const shiftedAfter = after.map((r) => {
                const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
                const newStart = new Date(baseTime + offsetMs + dayOffset);
                const newEnd = new Date(newStart.getTime() + r.durationMs);
                const newDate = new Date(baseTime + offsetMs + dayOffset);
                newDate.setHours(0, 0, 0, 0);
                const dateStr =
                    newDate.getFullYear() +
                    "-" +
                    String(newDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(newDate.getDate()).padStart(2, "0");
                return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
            });

            const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            const result = analyze(records);

            const lastBeforeGap = before[before.length - 1]!.dateOfSleep;
            const firstAfterGap = shiftedAfter[0]!.dateOfSleep;

            const dayBeforeGap = result.days.find((d) => d.date === lastBeforeGap)!;
            expect(dayBeforeGap.isGap).toBe(false);
            const dayAfterGap = result.days.find((d) => d.date === firstAfterGap)!;
            expect(dayAfterGap.isGap).toBe(false);

            const midIdx = result.days.indexOf(dayBeforeGap) + 20;
            expect(result.days[midIdx]!.isGap).toBe(true);

            const firstGapIdx = result.days.indexOf(dayBeforeGap) + 1;
            expect(result.days[firstGapIdx]!.isGap).toBe(true);

            const lastGapIdx = result.days.indexOf(dayAfterGap) - 1;
            expect(result.days[lastGapIdx]!.isGap).toBe(true);

            const gapDays = result.days.filter((d) => d.isGap);
            expect(gapDays.length).toBeGreaterThanOrEqual(38);
            expect(gapDays.length).toBeLessThanOrEqual(42);

            const forecastResult = analyze(records, 14);
            const forecastDays = forecastResult.days.filter((d) => d.isForecast);
            expect(forecastDays.every((d) => !d.isGap)).toBe(true);
        });
    });

    // ── Segment isolation tests ─────────────────────────────────────

    describe(`${algo.name} (${algo.id}) — segment isolation`, () => {
        const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
            analyzeWithAlgorithm(algo.id, records, extraDays);

        function shiftRecords(
            records: ReturnType<typeof generateSyntheticRecords>,
            baseTime: number,
            offsetDays: number
        ) {
            const offsetMs = offsetDays * 86_400_000;
            const firstStart = records[0]!.startTime.getTime();
            return records.map((r) => {
                const dayOffset = r.startTime.getTime() - firstStart;
                const newStart = new Date(baseTime + offsetMs + dayOffset);
                const newEnd = new Date(newStart.getTime() + r.durationMs);
                const newDate = new Date(baseTime + offsetMs + dayOffset);
                newDate.setHours(0, 0, 0, 0);
                const dateStr =
                    newDate.getFullYear() +
                    "-" +
                    String(newDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(newDate.getDate()).padStart(2, "0");
                return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
            });
        }

        it("cross-gap tau isolation: post-gap local tau tracks local data, not pre-gap", () => {
            const before = generateSyntheticRecords({ tau: 24.2, days: 90, noise: 0.3, seed: 3000 });
            const after = generateSyntheticRecords({ tau: 25.0, days: 90, noise: 0.3, seed: 3001, startMidpoint: 3 });

            const baseTime = before[0]!.startTime.getTime();
            const shiftedAfter = shiftRecords(after, baseTime, 120);

            const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            const result = analyze(records);

            const postGapDays = result.days.filter((d) => {
                const date = d.date;
                return !d.isGap && !d.isForecast && date > shiftedAfter[0]!.dateOfSleep;
            });
            expect(postGapDays.length).toBeGreaterThan(50);

            const postGapTaus = postGapDays.slice(20, -10).map((d) => d.localTau);
            const meanPostGapTau = postGapTaus.reduce((s, t) => s + t, 0) / postGapTaus.length;
            expect(Math.abs(meanPostGapTau - 25.0)).toBeLessThan(0.25);
        });

        it("multi-segment: three segments with different taus", () => {
            const seg1 = generateSyntheticRecords({ tau: 24.2, days: 60, noise: 0.3, seed: 3010 });
            const seg2 = generateSyntheticRecords({ tau: 25.0, days: 60, noise: 0.3, seed: 3011, startMidpoint: 3 });
            const seg3 = generateSyntheticRecords({ tau: 24.5, days: 60, noise: 0.3, seed: 3012, startMidpoint: 3 });

            const baseTime = seg1[0]!.startTime.getTime();
            const shifted2 = shiftRecords(seg2, baseTime, 80);
            const shifted3 = shiftRecords(seg3, baseTime, 160);

            const records = [...seg1, ...shifted2, ...shifted3].sort(
                (a, b) => a.startTime.getTime() - b.startTime.getTime()
            );
            const result = analyze(records);

            const gapDays = result.days.filter((d) => d.isGap);
            expect(gapDays.length).toBeGreaterThan(30);

            const allDataDays = result.days.filter((d) => !d.isGap && !d.isForecast);
            expect(allDataDays.length).toBeGreaterThan(150);
        });
    });

    it("handles two fragmented periods within 60 days tau=25", () => {
        const opts: Parameters<typeof generateSyntheticRecords>[0] = {
            tau: 25,
            days: 60,
            noise: 0.3,
            seed: 5000,
            fragmentedPeriods: [
                { startDay: 10, endDay: 15, boutsPerDay: 4, boutDuration: 2 },
                { startDay: 35, endDay: 40, boutsPerDay: 4, boutDuration: 2 },
            ],
        };
        const records = generateSyntheticRecords(opts);
        const result = analyzeWithAlgorithm(algo.id, records);
        maybeSaveViz(`integration_two-fragmented-periods_${algo.id}`, {
            title: `Tau=25 with two fragmented periods — ${algo.name}`,
            records,
            analysis: result,
            algorithmId: algo.id,
            groundTruth: opts,
        });
        expect(Math.abs(result.globalTau - 25)).toBeLessThan(0.25);
        expect(result.days.length).toBe(60);
    });

    // ── DSPD to N24 transition detection ────────────────────────────

    describe(`${algo.name} (${algo.id}) — DSPD to N24 transition`, () => {
        const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
            analyzeWithAlgorithm(algo.id, records, extraDays);

        it("detects N24 drift after long DSPD period (300d tau=24.0 + 30d tau=24.5)", () => {
            const records = generateSyntheticRecords({
                tauSegments: [
                    { untilDay: 300, tau: 24.0 },
                    { untilDay: 330, tau: 24.5 },
                ],
                days: 330,
                noise: 0.3,
                seed: 4000,
            });

            const result = analyze(records);

            const last15 = result.days.slice(-15);
            const meanTau = last15.reduce((s, d) => s + d.localTau, 0) / last15.length;
            expect(meanTau).toBeGreaterThan(24.2);
        });

        it("full dataset local tau matches recent-only (300d DSPD + 60d N24)", () => {
            const records = generateSyntheticRecords({
                tauSegments: [
                    { untilDay: 300, tau: 24.0 },
                    { untilDay: 360, tau: 24.5 },
                ],
                days: 360,
                noise: 0.3,
                seed: 4001,
            });

            const fullResult = analyze(records);

            const recentRecords = records.filter((r) => {
                const dayNum = Math.round((r.startTime.getTime() - records[0]!.startTime.getTime()) / 86_400_000);
                return dayNum >= 300;
            });
            const recentResult = analyze(recentRecords);

            const fullLastTau = fullResult.days[fullResult.days.length - 1]!.localTau;
            const recentLastTau = recentResult.days[recentResult.days.length - 1]!.localTau;

            expect(Math.abs(fullLastTau - recentLastTau)).toBeLessThan(0.3);
        });

        it("detects gradual transition (250d tau=24.0 → 30d tau=24.15 → 30d tau=24.5)", () => {
            const records = generateSyntheticRecords({
                tauSegments: [
                    { untilDay: 250, tau: 24.0 },
                    { untilDay: 280, tau: 24.15 },
                    { untilDay: 310, tau: 24.5 },
                ],
                days: 310,
                noise: 0.3,
                seed: 4002,
            });

            const result = analyze(records);

            const last15 = result.days.slice(-15);
            const meanTau = last15.reduce((s, d) => s + d.localTau, 0) / last15.length;
            expect(meanTau).toBeGreaterThan(24.2);
        });
    });
}
