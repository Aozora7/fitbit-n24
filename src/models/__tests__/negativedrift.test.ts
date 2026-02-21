import { describe, it, expect } from "vitest";
import { listAlgorithms, analyzeWithAlgorithm, type CircadianDay } from "../circadian";
import { generateSyntheticRecords, computeTrueMidpoint, type SyntheticOptions } from "./fixtures/synthetic";
import { maybeSaveViz } from "./fixtures/visualize";

const algorithms = listAlgorithms();

function circularDistance(a: number, b: number): number {
    const diff = Math.abs((((a % 24) + 24) % 24) - (((b % 24) + 24) % 24));
    return Math.min(diff, 24 - diff);
}

function getOverlayMidpoint(day: CircadianDay): number {
    return (day.nightStartHour + day.nightEndHour) / 2;
}

for (const algo of algorithms) {
    const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
        analyzeWithAlgorithm(algo.id, records, extraDays);

    describe(`${algo.name} (${algo.id}) — negative drift (tau < 24h)`, () => {
        it("detects tau=23.5 within ±0.3h", () => {
            const opts: SyntheticOptions = { tau: 23.5, days: 120, noise: 0.3, seed: 7001 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            maybeSaveViz(`negativedrift_tau-23.5_${algo.id}`, {
                title: `Negative drift τ=23.5 — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: opts,
            });

            expect(Math.abs(result.globalTau - 23.5)).toBeLessThan(0.3);
        });

        it("detects tau=23.8 within ±0.15h", () => {
            const opts: SyntheticOptions = { tau: 23.8, days: 120, noise: 0.3, seed: 7002 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            expect(Math.abs(result.globalTau - 23.8)).toBeLessThan(0.15);
        });

        it("correctly tracks phase advancing (earlier each day)", () => {
            const opts: SyntheticOptions = { tau: 23.5, days: 60, noise: 0.3, seed: 7003 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            const midpoints = result.days.slice(10, 50).map(getOverlayMidpoint);

            let advancingCount = 0;
            for (let i = 1; i < midpoints.length; i++) {
                const signed = ((midpoints[i]! - midpoints[i - 1]! + 12) % 24) - 12;
                if (signed < 0) advancingCount++;
            }

            const advancingRatio = advancingCount / (midpoints.length - 1);
            expect(advancingRatio).toBeGreaterThan(0.5);
        });

        it("localTau stays in valid range for tau=23.5", () => {
            const opts: SyntheticOptions = { tau: 23.5, days: 90, noise: 0.3, seed: 7004 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            for (const day of result.days) {
                expect(day.localTau).toBeGreaterThanOrEqual(22.5);
                expect(day.localTau).toBeLessThanOrEqual(27.0);
            }
        });

        it("phase error stays bounded for tau=23.5", () => {
            const opts: SyntheticOptions = { tau: 23.5, days: 120, noise: 0.3, seed: 7005 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            const baseDate = new Date("2024-01-01T00:00:00");
            const phaseErrors: number[] = [];

            for (const day of result.days) {
                if (day.isForecast) continue;
                const dayDate = new Date(day.date + "T00:00:00");
                const d = Math.round((dayDate.getTime() - baseDate.getTime()) / 86_400_000);

                const predictedMid = getOverlayMidpoint(day);
                const trueMid = computeTrueMidpoint(d, opts);
                const error = circularDistance(predictedMid, trueMid);
                phaseErrors.push(error);
            }

            phaseErrors.sort((a, b) => a - b);
            const meanError = phaseErrors.reduce((s, e) => s + e, 0) / phaseErrors.length;
            const p90Error = phaseErrors[Math.floor(phaseErrors.length * 0.9)]!;

            if (algo.id === "csf-v1") {
                expect(meanError).toBeLessThan(3.0);
                expect(p90Error).toBeLessThan(5.0);
            } else {
                expect(meanError).toBeLessThan(6.0);
                expect(p90Error).toBeLessThan(12.0);
            }
        });
    });

    describe(`${algo.name} (${algo.id}) — jet lag recovery simulation`, () => {
        it("eastward travel: detects entrainment phase advance", () => {
            const eastTravelOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 30, tau: 24.0 },
                    { untilDay: 45, tau: 23.0 },
                    { untilDay: 90, tau: 24.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 7100,
            };

            const records = generateSyntheticRecords(eastTravelOpts);
            const result = analyze(records);

            maybeSaveViz(`jetlag_eastward-travel_${algo.id}`, {
                title: `Eastward jet lag recovery — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: eastTravelOpts,
            });

            const beforeTravel = result.days.slice(15, 28).map((d) => d.localTau);
            const meanBefore = beforeTravel.reduce((s, t) => s + t, 0) / beforeTravel.length;
            expect(Math.abs(meanBefore - 24.0)).toBeLessThan(0.3);

            const duringRecovery = result.days.slice(35, 42).map((d) => d.localTau);
            const meanDuring = duringRecovery.reduce((s, t) => s + t, 0) / duringRecovery.length;
            expect(meanDuring).toBeLessThan(24.2);

            const afterRecovery = result.days.slice(60, 85).map((d) => d.localTau);
            const meanAfter = afterRecovery.reduce((s, t) => s + t, 0) / afterRecovery.length;
            expect(Math.abs(meanAfter - 24.0)).toBeLessThan(0.4);
        });

        it("westward travel: detects entrainment phase delay", () => {
            const westTravelOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 30, tau: 24.0 },
                    { untilDay: 45, tau: 25.0 },
                    { untilDay: 90, tau: 24.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 7101,
            };

            const records = generateSyntheticRecords(westTravelOpts);
            const result = analyze(records);

            maybeSaveViz(`jetlag_westward-travel_${algo.id}`, {
                title: `Westward jet lag recovery — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: westTravelOpts,
            });

            const duringRecovery = result.days.slice(35, 42).map((d) => d.localTau);
            const meanDuring = duringRecovery.reduce((s, t) => s + t, 0) / duringRecovery.length;
            expect(meanDuring).toBeGreaterThan(24.0);

            const afterRecovery = result.days.slice(60, 85).map((d) => d.localTau);
            const meanAfter = afterRecovery.reduce((s, t) => s + t, 0) / afterRecovery.length;
            expect(Math.abs(meanAfter - 24.0)).toBeLessThan(0.4);
        });

        it("multiple timezone crossings: tracks alternating drift", () => {
            const multiTravelOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 20, tau: 24.0 },
                    { untilDay: 30, tau: 23.5 },
                    { untilDay: 50, tau: 24.0 },
                    { untilDay: 60, tau: 25.0 },
                    { untilDay: 90, tau: 24.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 7102,
            };

            const records = generateSyntheticRecords(multiTravelOpts);
            const result = analyze(records);

            maybeSaveViz(`jetlag_multiple-crossings_${algo.id}`, {
                title: `Multiple timezone crossings — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: multiTravelOpts,
            });

            const firstRecovery = result.days.slice(23, 28).map((d) => d.localTau);
            const meanFirst = firstRecovery.reduce((s, t) => s + t, 0) / firstRecovery.length;
            expect(meanFirst).toBeLessThan(24.3);

            const secondRecovery = result.days.slice(53, 58).map((d) => d.localTau);
            const meanSecond = secondRecovery.reduce((s, t) => s + t, 0) / secondRecovery.length;
            expect(meanSecond).toBeGreaterThan(24.3);

            const final = result.days.slice(70, 85).map((d) => d.localTau);
            const meanFinal = final.reduce((s, t) => s + t, 0) / final.length;
            expect(Math.abs(meanFinal - 24.0)).toBeLessThan(0.5);
        });

        it("rapid entrainment: short recovery period", () => {
            const rapidOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 40, tau: 24.0 },
                    { untilDay: 47, tau: 22.5 },
                    { untilDay: 80, tau: 24.0 },
                ],
                days: 80,
                noise: 0.3,
                seed: 7103,
            };

            const records = generateSyntheticRecords(rapidOpts);
            const result = analyze(records);

            const duringRecovery = result.days.slice(42, 46).map((d) => d.localTau);
            const meanDuring = duringRecovery.reduce((s, t) => s + t, 0) / duringRecovery.length;
            expect(meanDuring).toBeLessThan(24.2);

            const afterRecovery = result.days.slice(55, 75).map((d) => d.localTau);
            const meanAfter = afterRecovery.reduce((s, t) => s + t, 0) / afterRecovery.length;
            expect(Math.abs(meanAfter - 24.0)).toBeLessThan(0.5);
        });

        it("entrained person with stable 24h tau stays near 24", () => {
            const opts: SyntheticOptions = { tau: 24.0, days: 120, noise: 0.3, seed: 7104 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            const middleDays = result.days.slice(30, 90).map((d) => d.localTau);
            const meanTau = middleDays.reduce((s, t) => s + t, 0) / middleDays.length;
            expect(Math.abs(meanTau - 24.0)).toBeLessThan(0.2);

            const tauVariance = middleDays.reduce((s, t) => s + (t - meanTau) ** 2, 0) / middleDays.length;
            expect(tauVariance).toBeLessThan(0.1);
        });
    });

    describe(`${algo.name} (${algo.id}) — negative drift edge cases`, () => {
        it("very strong negative drift (tau=22.5) is handled", () => {
            const opts: SyntheticOptions = { tau: 22.5, days: 60, noise: 0.3, seed: 7200 };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            for (const day of result.days) {
                expect(day.localTau).toBeGreaterThanOrEqual(22.0);
            }
        });

        it("negative drift with gaps is still detected", () => {
            const opts: SyntheticOptions = {
                tau: 23.5,
                days: 120,
                noise: 0.3,
                gapFraction: 0.2,
                seed: 7201,
            };
            const records = generateSyntheticRecords(opts);
            const result = analyze(records);

            expect(Math.abs(result.globalTau - 23.5)).toBeLessThan(0.4);
        });

        it("negative to positive drift transition", () => {
            const transitionOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 45, tau: 23.5 },
                    { untilDay: 90, tau: 25.0 },
                ],
                days: 90,
                noise: 0.3,
                seed: 7202,
            };

            const records = generateSyntheticRecords(transitionOpts);
            const result = analyze(records);

            maybeSaveViz(`negativedrift_transition-to-positive_${algo.id}`, {
                title: `Negative→Positive drift transition — ${algo.name}`,
                records,
                analysis: result,
                algorithmId: algo.id,
                groundTruth: transitionOpts,
            });

            const firstHalf = result.days.slice(15, 35).map((d) => d.localTau);
            const meanFirst = firstHalf.reduce((s, t) => s + t, 0) / firstHalf.length;
            expect(meanFirst).toBeLessThan(24.2);

            const secondHalf = result.days.slice(55, 80).map((d) => d.localTau);
            const meanSecond = secondHalf.reduce((s, t) => s + t, 0) / secondHalf.length;
            expect(meanSecond).toBeGreaterThan(24.3);
        });

        it("oscillating drift (negative-positive-negative)", () => {
            const oscillatingOpts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 30, tau: 23.5 },
                    { untilDay: 60, tau: 24.5 },
                    { untilDay: 90, tau: 23.8 },
                ],
                days: 90,
                noise: 0.3,
                seed: 7203,
            };

            const records = generateSyntheticRecords(oscillatingOpts);
            const result = analyze(records);

            const phase1 = result.days.slice(15, 25).map((d) => d.localTau);
            const meanPhase1 = phase1.reduce((s, t) => s + t, 0) / phase1.length;
            expect(meanPhase1).toBeLessThan(24.2);

            const phase2 = result.days.slice(40, 55).map((d) => d.localTau);
            const meanPhase2 = phase2.reduce((s, t) => s + t, 0) / phase2.length;
            expect(meanPhase2).toBeGreaterThan(24.0);

            const phase3 = result.days.slice(70, 85).map((d) => d.localTau);
            const meanPhase3 = phase3.reduce((s, t) => s + t, 0) / phase3.length;
            expect(meanPhase3).toBeLessThan(24.3);
        });
    });
}
