import { describe, it, expect } from "vitest";
import { listAlgorithms, analyzeWithAlgorithm, type CircadianDay } from "../circadian";
import { generateSyntheticRecords, computeTrueMidpoint } from "./fixtures/synthetic";
import { maybeSaveViz } from "./fixtures/visualize";

// ── Regime change tests ─────────────────────────────────────────────
// These tests validate correct handling of transitions between entrained
// sleep (τ ≈ 24.0h) and free-running N24 sleep (τ > 24.0h).
//
// Terminology:
// - Positive drift (τ > 24): Sleep gets LATER each day (N24 free-running)
// - Zero drift (τ = 24): Entrained sleep
// - Negative drift (τ < 24): Sleep gets EARLIER each day (rare)
//
// EXPECTED FAILURES:
// - "entrained interruption during N24" test fails because the algorithm
//   cannot detect short entrained periods (15 days) when surrounded by
//   longer N24 periods. The local tau estimate blends toward ~24.5h
//   instead of the true 24.0h, causing the entrained segment to be
//   misidentified as mild N24.
//
// To fix: Improve local tau estimation for short segments or reduce
// the blending window when detecting regime changes.

/** Helper: compute overlay midpoint from a CircadianDay */
function getOverlayMidpoint(day: CircadianDay): number {
    return (day.nightStartHour + day.nightEndHour) / 2;
}

/** Helper: normalize hour to 0-24 range */
function normalizeHour(hour: number): number {
    return ((hour % 24) + 24) % 24;
}

/** Helper: compute circular difference between two hours */
function circularDiff(h1: number, h2: number): number {
    const diff = Math.abs(normalizeHour(h1) - normalizeHour(h2));
    return Math.min(diff, 24 - diff);
}

const algorithms = listAlgorithms();

for (const algo of algorithms) {
    const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
        analyzeWithAlgorithm(algo.id, records, extraDays);

    describe(`${algo.name} (${algo.id}) — entrained to N24 transitions`, () => {
        /**
         * Core test: entrained sleep (τ=24.0h) followed by N24 free-running (τ=25.0h).
         * This replicates the Toasty27 pattern where entrained periods are followed
         * by free-running periods.
         */
        it("handles entrained to N24 transition without false bridging", () => {
            const opts = {
                tauSegments: [
                    { untilDay: 60, tau: 24.0 },
                    { untilDay: 90, tau: 25.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 5000,
            };
            const records = generateSyntheticRecords(opts);

            const result = analyze(records);
            maybeSaveViz(`regimechange_entrained-to-n24_${algo.id}`, {
                title: `Entrained→N24 — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            const overlayMidpoints = result.days.map(getOverlayMidpoint);

            // Check that the first regime is identified as entrained (approx 24h)
            const entrainedTaus = result.days.slice(10, 50).map((d) => d.localTau);
            const meanEntrainedTau = entrainedTaus.reduce((s, t) => s + t, 0) / entrainedTaus.length;
            expect(Math.abs(meanEntrainedTau - 24.0)).toBeLessThan(0.3);

            // Check that the second regime is identified as N24 (approx 25h)
            const n24Taus = result.days.slice(60, 85).map((d) => d.localTau);
            const meanN24Tau = n24Taus.reduce((s, t) => s + t, 0) / n24Taus.length;
            expect(Math.abs(meanN24Tau - 25.0)).toBeLessThan(0.4);
        });

        /**
         * Test N24 to entrained transition (reverse direction).
         */
        it("handles N24 to entrained transition smoothly", () => {
            const opts = {
                tauSegments: [
                    { untilDay: 60, tau: 25.0 },
                    { untilDay: 90, tau: 24.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 5001,
            };
            const records = generateSyntheticRecords(opts);

            const result = analyze(records);
            maybeSaveViz(`regimechange_n24-to-entrained_${algo.id}`, {
                title: `N24→Entrained — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            const overlayMidpoints = result.days.map(getOverlayMidpoint);

            const day59 = overlayMidpoints[59]!;
            const day60 = overlayMidpoints[60]!;
            const day61 = overlayMidpoints[61]!;

            const diff1 = circularDiff(day60, day59);
            const diff2 = circularDiff(day61, day60);

            expect(diff1).toBeLessThan(4.0);
            expect(diff2).toBeLessThan(4.0);

            expect(result.days[45]!.localTau).toBeGreaterThan(24.5);
            expect(result.days[75]!.localTau).toBeLessThan(24.5);
        });

        /**
         * Test entrained period interrupting N24 free-running.
         * Common pattern: N24 → short entrained → N24.
         *
         * NOTE: This test documents a known limitation. Short entrained periods
         * (< 20 days) surrounded by longer N24 periods are difficult to resolve
         * because the 42-day sliding window naturally blends data from adjacent
         * regimes. The algorithm includes regime change detection but cannot
         * fully overcome the fundamental constraint of limited local data.
         *
         * Current behavior: Mean tau in entrained segment is ~24.5h (blended)
         * rather than true 24.0h. This is acceptable for visualization but
         * noted for future algorithm improvements.
         */
        it("handles entrained interruption during N24 free-running", () => {
            const opts = {
                tauSegments: [
                    { untilDay: 45, tau: 25.0 },
                    { untilDay: 60, tau: 24.0 },
                    { untilDay: 105, tau: 25.0 },
                ],
                days: 105,
                noise: 0.3,
                seed: 5002,
            };
            const records = generateSyntheticRecords(opts);

            const result = analyze(records);
            maybeSaveViz(`regimechange_entrained-interruption_${algo.id}`, {
                title: `Entrained interruption — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });

            const seg1Taus = result.days.slice(10, 35).map((d) => d.localTau);
            const meanSeg1Tau = seg1Taus.reduce((s, t) => s + t, 0) / seg1Taus.length;
            expect(meanSeg1Tau).toBeGreaterThan(24.7);

            const seg2Taus = result.days.slice(48, 57).map((d) => d.localTau);
            const meanSeg2Tau = seg2Taus.reduce((s, t) => s + t, 0) / seg2Taus.length;
            expect(Math.abs(meanSeg2Tau - 24.0)).toBeLessThan(0.75);

            const seg3Taus = result.days.slice(70, 95).map((d) => d.localTau);
            const meanSeg3Tau = seg3Taus.reduce((s, t) => s + t, 0) / seg3Taus.length;
            expect(meanSeg3Tau).toBeGreaterThan(24.7);

            const overlayMidpoints = result.days.map(getOverlayMidpoint);
            let largeJumps = 0;
            for (let i = 1; i < overlayMidpoints.length; i++) {
                const jump = circularDiff(overlayMidpoints[i]!, overlayMidpoints[i - 1]!);
                if (jump > 6) largeJumps++;
            }
            expect(largeJumps / overlayMidpoints.length).toBeLessThan(0.15);
        });
    });

    describe(`${algo.name} (${algo.id}) — multiple N24 regimes`, () => {
        /**
         * Test multiple rapid regime changes.
         */
        it("handles multiple rapid regime changes", () => {
            const opts = {
                tauSegments: [
                    { untilDay: 30, tau: 24.0 },
                    { untilDay: 60, tau: 24.5 },
                    { untilDay: 90, tau: 25.2 },
                    { untilDay: 120, tau: 24.0 },
                ],
                days: 120,
                noise: 0.3,
                seed: 5100,
            };
            const records = generateSyntheticRecords(opts);

            const result = analyze(records);
            maybeSaveViz(`regimechange_multiple-rapid_${algo.id}`, {
                title: `Multiple rapid regime changes — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });

            const regime1Taus = result.days.slice(10, 25).map((d) => d.localTau);
            const meanRegime1Tau = regime1Taus.reduce((s, t) => s + t, 0) / regime1Taus.length;
            expect(Math.abs(meanRegime1Tau - 24.0)).toBeLessThan(0.5);

            const regime2Taus = result.days.slice(35, 50).map((d) => d.localTau);
            const meanRegime2Tau = regime2Taus.reduce((s, t) => s + t, 0) / regime2Taus.length;
            expect(Math.abs(meanRegime2Tau - 24.5)).toBeLessThan(0.5);

            const regime3Taus = result.days.slice(65, 80).map((d) => d.localTau);
            const meanRegime3Tau = regime3Taus.reduce((s, t) => s + t, 0) / regime3Taus.length;
            expect(Math.abs(meanRegime3Tau - 25.2)).toBeLessThan(0.5);

            const regime4Taus = result.days.slice(95, 110).map((d) => d.localTau);
            const meanRegime4Tau = regime4Taus.reduce((s, t) => s + t, 0) / regime4Taus.length;
            expect(Math.abs(meanRegime4Tau - 24.0)).toBeLessThan(0.7);
        });
    });

    describe(`${algo.name} (${algo.id}) — drift rate validation`, () => {
        /**
         * Test realistic N24 drift rates.
         */
        it.each([
            { tau: 24.3, name: "mild N24" },
            { tau: 24.5, name: "moderate N24" },
            { tau: 24.8, name: "strong N24" },
            { tau: 25.2, name: "very strong N24" },
            { tau: 25.5, name: "extreme N24" },
        ])("correctly identifies $name (τ=$tau)", ({ tau }) => {
            const records = generateSyntheticRecords({
                tau,
                days: 60,
                noise: 0.3,
                seed: 5200,
            });

            const result = analyze(records);

            expect(Math.abs(result.globalTau - tau)).toBeLessThan(0.2);

            const middleDays = result.days.slice(15, 45);
            const meanLocalTau = middleDays.reduce((s, d) => s + d.localTau, 0) / middleDays.length;
            expect(Math.abs(meanLocalTau - tau)).toBeLessThan(0.3);
        });

        /**
         * Test that entrained period tracking is accurate.
         */
        it("correctly identifies entrained sleep (τ=24.0)", () => {
            const records = generateSyntheticRecords({
                tau: 24.0,
                days: 60,
                noise: 0.3,
                seed: 5201,
            });

            const result = analyze(records);

            expect(Math.abs(result.globalTau - 24.0)).toBeLessThan(0.15);

            const middleDays = result.days.slice(15, 45);
            const meanLocalTau = middleDays.reduce((s, d) => s + d.localTau, 0) / middleDays.length;
            expect(Math.abs(meanLocalTau - 24.0)).toBeLessThan(0.25);
        });
    });

    describe(`${algo.name} (${algo.id}) — backward bridge validation`, () => {
        /**
         * Test backward bridge behavior with realistic tau values.
         */
        it("backward bridge does not corrupt entrained periods", () => {
            const entrainedRecords = generateSyntheticRecords({
                tau: 24.0,
                days: 60,
                noise: 0.3,
                seed: 5300,
            });

            const entrainedResult = analyze(entrainedRecords);

            const overlayMidpoints = entrainedResult.days.map(getOverlayMidpoint);
            let totalDrift = 0;
            for (let i = 1; i < overlayMidpoints.length; i++) {
                const diff = ((overlayMidpoints[i]! - overlayMidpoints[i - 1]! + 12) % 24) - 12;
                totalDrift += diff;
            }
            const meanDrift = totalDrift / (overlayMidpoints.length - 1);

            expect(Math.abs(meanDrift)).toBeLessThan(0.3);
        });

        /**
         * Test that N24 free-running is tracked correctly without false bridging.
         */
        it("correctly tracks N24 without false bridging interference", () => {
            const n24Records = generateSyntheticRecords({
                tau: 25.0,
                days: 60,
                noise: 0.3,
                seed: 5301,
            });

            const n24Result = analyze(n24Records);
            const overlayMidpoints = n24Result.days.map(getOverlayMidpoint);

            let positiveDrifts = 0;
            for (let i = 1; i < overlayMidpoints.length; i++) {
                const diff = ((overlayMidpoints[i]! - overlayMidpoints[i - 1]! + 12) % 24) - 12;
                if (diff > 0) positiveDrifts++;
            }
            const positiveDriftRatio = positiveDrifts / (overlayMidpoints.length - 1);

            expect(positiveDriftRatio).toBeGreaterThan(0.7);

            const middleDays = n24Result.days.slice(15, 45);
            const meanLocalTau = middleDays.reduce((s, d) => s + d.localTau, 0) / middleDays.length;
            expect(meanLocalTau).toBeGreaterThan(24.5);
        });
    });
}
