import { describe, it, expect } from "vitest";
import { listAlgorithms, analyzeWithAlgorithm, type CircadianAnalysis } from "../circadian";
import type { RegressionAnalysis } from "../circadian";
import { computePeriodogram } from "../periodogram";
import { generateSyntheticRecords, computeTrueMidpoint, type SyntheticOptions } from "./fixtures/synthetic";
import { hasRealData, loadRealData } from "./fixtures/loadRealData";
import { maybeSaveViz } from "./fixtures/visualize";

const AOZORA_FILE = "Aozora_2026-02-13.json";
import { assertHardDriftLimits, computeDriftPenalty } from "./fixtures/driftPenalty";

const algorithms = listAlgorithms();

// ── Scoring utilities ──────────────────────────────────────────────

/** Circular distance between two hours (mod 24), returns 0-12 */
function circularDistance(a: number, b: number): number {
    const diff = Math.abs((((a % 24) + 24) % 24) - (((b % 24) + 24) % 24));
    return Math.min(diff, 24 - diff);
}

interface AccuracyScore {
    tauError: number;
    meanPhaseError: number;
    medianPhaseError: number;
    p90PhaseError: number;
    forecastPhaseError: number;
    residualRatio: number;
}

/** Score an analysis result against synthetic ground truth */
function scoreAnalysis(analysis: CircadianAnalysis, opts: SyntheticOptions, holdoutStart?: number): AccuracyScore {
    const trueTau = opts.tauSegments
        ? opts.tauSegments.reduce((sum, s, i, arr) => {
              const prevEnd = i === 0 ? 0 : arr[i - 1]!.untilDay;
              const span = s.untilDay - prevEnd;
              return sum + s.tau * span;
          }, 0) / (opts.tauSegments[opts.tauSegments.length - 1]?.untilDay ?? 1)
        : (opts.tau ?? 24.5);

    const tauError = Math.abs(analysis.globalTau - trueTau);

    const phaseErrors: number[] = [];
    const forecastErrors: number[] = [];

    const baseDate = new Date("2024-01-01T00:00:00");
    for (const day of analysis.days) {
        const dayDate = new Date(day.date + "T00:00:00");
        const d = Math.round((dayDate.getTime() - baseDate.getTime()) / 86_400_000);

        const predictedMid = (day.nightStartHour + day.nightEndHour) / 2;
        const trueMid = computeTrueMidpoint(d, opts);
        const error = circularDistance(predictedMid, trueMid);

        if (holdoutStart !== undefined && d >= holdoutStart) {
            forecastErrors.push(error);
        } else if (!day.isForecast) {
            phaseErrors.push(error);
        }
    }

    phaseErrors.sort((a, b) => a - b);
    const meanPhaseError = phaseErrors.length > 0 ? phaseErrors.reduce((s, e) => s + e, 0) / phaseErrors.length : 0;
    const medianPhaseError = phaseErrors.length > 0 ? phaseErrors[Math.floor(phaseErrors.length / 2)]! : 0;
    const p90PhaseError = phaseErrors.length > 0 ? phaseErrors[Math.floor(phaseErrors.length * 0.9)]! : 0;
    const forecastPhaseError =
        forecastErrors.length > 0 ? forecastErrors.reduce((s, e) => s + e, 0) / forecastErrors.length : 0;

    const noise = opts.noise ?? 0.5;
    // medianResidualHours is regression-specific; skip for other algorithms
    const medianResidualHours =
        "medianResidualHours" in analysis ? (analysis as RegressionAnalysis).medianResidualHours : 0;
    const residualRatio = noise > 0 ? medianResidualHours / noise : 0;

    return {
        tauError,
        meanPhaseError,
        medianPhaseError,
        p90PhaseError,
        forecastPhaseError,
        residualRatio,
    };
}

/** Print a score summary table row */
function logScore(label: string, score: AccuracyScore): void {
    console.log(
        `  ${label.padEnd(24)} tau±${score.tauError.toFixed(3)}  phase: mean=${score.meanPhaseError.toFixed(2)} med=${score.medianPhaseError.toFixed(2)} p90=${score.p90PhaseError.toFixed(2)}  resid=${score.residualRatio.toFixed(2)}`
    );
}

// ── Benchmark helper ────────────────────────────────────────────────

function benchmark(label: string, metric: string, value: number, softTarget: number, lowerIsBetter = true): void {
    const pass = lowerIsBetter ? value <= softTarget : value >= softTarget;
    const op = lowerIsBetter ? "<" : ">";
    console.log(
        `BENCHMARK\t${label}\t${metric}=${value.toFixed(4)}\ttarget${op}${softTarget}\t${pass ? "PASS" : "REGRESSED"}`
    );
}

function logDriftPenalty(label: string, analysis: CircadianAnalysis): void {
    const penalty = computeDriftPenalty(analysis.days);
    console.log(
        `DRIFT_PENALTY\t${label}\tpenalty=${penalty.totalPenalty.toFixed(2)}\tdays=${penalty.penaltyDays}\tmaxStreak=${penalty.maxConsecutivePenaltyDays}\tfraction=${(penalty.penaltyFraction * 100).toFixed(1)}%`
    );
}

// ── Benchmark 1: Tau estimation sweep ─────────────────────────────

for (const algo of algorithms) {
    const analyze = (records: Parameters<typeof analyzeWithAlgorithm>[1], extraDays?: number) =>
        analyzeWithAlgorithm(algo.id, records, extraDays);
    const isRegression = algo.id === "regression-v1";

    describe(`${algo.name} (${algo.id}) — benchmark: tau estimation sweep`, () => {
        const taus = [24.0, 24.2, 24.5, 24.7, 25.0, 25.5];

        for (const tau of taus) {
            it(`tau=${tau}: tau error`, () => {
                const opts: SyntheticOptions = { tau, days: 120, noise: 0.3, seed: Math.round(tau * 100) };
                const records = generateSyntheticRecords(opts);
                const analysis = analyze(records);
                maybeSaveViz(`scoring_tau-${tau}_${algo.id}`, {
                    title: `Tau sweep τ=${tau} — ${algo.name}`,
                    records,
                    analysis,
                    algorithmId: algo.id,
                    groundTruth: opts,
                });
                const score = scoreAnalysis(analysis, opts);
                logScore(`tau=${tau}`, score);
                benchmark(`tau-sweep/${tau}`, "tauError", score.tauError, 0.04);
                assertHardDriftLimits(analysis.days);
                logDriftPenalty(`tau-sweep/${tau}`, analysis);
                // Catastrophic guard only
                expect(score.tauError).toBeLessThan(1.0);
            });
        }
    });

    // ── Benchmark 2: Phase prediction accuracy ──────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: phase prediction accuracy`, () => {
        it("phase error", () => {
            const opts: SyntheticOptions = { tau: 24.5, days: 120, noise: 0.3, seed: 200 };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            maybeSaveViz(`scoring_phase-accuracy_${algo.id}`, {
                title: `Phase accuracy — ${algo.name}`,
                records,
                analysis,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            const score = scoreAnalysis(analysis, opts);
            logScore("phase-accuracy", score);
            benchmark("phase-accuracy", "meanPhaseError", score.meanPhaseError, 0.5);
            benchmark("phase-accuracy", "p90PhaseError", score.p90PhaseError, 1.5);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("phase-accuracy", analysis);
            // Catastrophic guards
            expect(score.meanPhaseError).toBeLessThan(3.0);
            expect(score.p90PhaseError).toBeLessThan(6.0);
        });
    });

    // ── Benchmark 3: Noise degradation curve ────────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: noise degradation`, () => {
        const noises = [0.3, 0.5, 1.0, 1.5, 2.0];

        for (const noise of noises) {
            it(`noise=${noise}: bounded degradation`, () => {
                const opts: SyntheticOptions = { tau: 24.5, days: 150, noise, seed: 300 + Math.round(noise * 10) };
                const records = generateSyntheticRecords(opts);
                const analysis = analyze(records);
                const score = scoreAnalysis(analysis, opts);
                logScore(`noise=${noise}`, score);
                benchmark(`noise/${noise}`, "tauError", score.tauError, 0.05);
                if (isRegression) {
                    benchmark(`noise/${noise}`, "residualRatio", score.residualRatio, 0.3, false);
                }
                benchmark(`noise/${noise}`, "meanPhaseError", score.meanPhaseError, 0.5 + noise * 0.3);
                assertHardDriftLimits(analysis.days);
                logDriftPenalty(`noise/${noise}`, analysis);
                // Catastrophic guards
                expect(score.tauError).toBeLessThan(1.0);
                if (isRegression) {
                    expect(score.residualRatio).toBeLessThan(5.0);
                }
                expect(score.meanPhaseError).toBeLessThan(5.0);
            });
        }
    });

    // ── Benchmark 4: Gap degradation curve ──────────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: gap degradation`, () => {
        const cases: [number, number][] = [
            [0.1, 0.03],
            [0.3, 0.05],
            [0.5, 0.1],
        ];

        for (const [gap, softTarget] of cases) {
            it(`gap=${(gap * 100).toFixed(0)}%: tau error`, () => {
                const opts: SyntheticOptions = {
                    tau: 24.5,
                    days: 150,
                    noise: 0.5,
                    gapFraction: gap,
                    seed: 400 + Math.round(gap * 100),
                };
                const records = generateSyntheticRecords(opts);
                const analysis = analyze(records);
                const score = scoreAnalysis(analysis, opts);
                logScore(`gap=${(gap * 100).toFixed(0)}%`, score);
                benchmark(`gap/${(gap * 100).toFixed(0)}%`, "tauError", score.tauError, softTarget);
                assertHardDriftLimits(analysis.days);
                logDriftPenalty(`gap/${(gap * 100).toFixed(0)}%`, analysis);
                // Catastrophic guard
                expect(score.tauError).toBeLessThan(0.5);
            });
        }
    });

    // ── Benchmark 5: Variable tau (step change) ─────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: variable tau`, () => {
        it("tracks step change in tau", () => {
            const opts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 90, tau: 24.2 },
                    { untilDay: 180, tau: 24.8 },
                ],
                days: 180,
                noise: 0.3,
                seed: 500,
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            maybeSaveViz(`scoring_variable-tau_${algo.id}`, {
                title: `Variable tau (step change) — ${algo.name}`,
                records,
                analysis,
                algorithmId: algo.id,
                groundTruth: opts,
            });

            const baseDate = new Date("2024-01-01T00:00:00");
            const firstHalfTaus: number[] = [];
            const secondHalfTaus: number[] = [];

            for (const day of analysis.days) {
                if (day.isForecast) continue;
                const d = Math.round((new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000);
                if (d >= 15 && d < 75) firstHalfTaus.push(day.localTau);
                else if (d >= 105 && d < 165) secondHalfTaus.push(day.localTau);
            }

            const meanFirst = firstHalfTaus.reduce((s, t) => s + t, 0) / firstHalfTaus.length;
            const meanSecond = secondHalfTaus.reduce((s, t) => s + t, 0) / secondHalfTaus.length;

            console.log(
                `  variable tau: first half mean=${meanFirst.toFixed(3)}, second half mean=${meanSecond.toFixed(3)}`
            );
            benchmark("variable-tau", "firstHalfError", Math.abs(meanFirst - 24.2), 0.1);
            benchmark("variable-tau", "secondHalfError", Math.abs(meanSecond - 24.8), 0.1);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("variable-tau", analysis);
            // Catastrophic guards
            expect(Math.abs(meanFirst - 24.2)).toBeLessThan(1.0);
            expect(Math.abs(meanSecond - 24.8)).toBeLessThan(1.0);
        });
    });

    // ── Benchmark 6: Nap contamination resistance ───────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: nap contamination`, () => {
        it("tau error with 50% long-nap days", () => {
            const opts: SyntheticOptions = { tau: 24.5, days: 120, noise: 0.3, seed: 600 };
            const records = generateSyntheticRecords(opts);

            const baseDate = new Date("2024-01-01T00:00:00");
            let napId = 90000;
            for (let d = 0; d < 120; d += 2) {
                const dayDate = new Date(baseDate);
                dayDate.setDate(dayDate.getDate() + d);
                const trueMid = computeTrueMidpoint(d, opts);
                const napMid = trueMid + 6;
                const napDur = 5.5;
                const halfDur = napDur / 2;
                const startMs = dayDate.getTime() + (napMid - halfDur) * 3_600_000;
                const endMs = dayDate.getTime() + (napMid + halfDur) * 3_600_000;
                const durationMs = endMs - startMs;
                const dateStr =
                    dayDate.getFullYear() +
                    "-" +
                    String(dayDate.getMonth() + 1).padStart(2, "0") +
                    "-" +
                    String(dayDate.getDate()).padStart(2, "0");

                records.push({
                    logId: napId++,
                    dateOfSleep: dateStr,
                    startTime: new Date(startMs),
                    endTime: new Date(endMs),
                    durationMs,
                    durationHours: durationMs / 3_600_000,
                    efficiency: 80,
                    minutesAsleep: Math.round((durationMs / 60_000) * 0.85),
                    minutesAwake: Math.round((durationMs / 60_000) * 0.15),
                    isMainSleep: false,
                    sleepScore: 0.7,
                });
            }

            records.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
            const naps = records.filter((r) => !r.isMainSleep);
            expect(naps.length).toBeGreaterThan(30);

            const analysis = analyze(records);
            maybeSaveViz(`scoring_nap-contamination_${algo.id}`, {
                title: `Nap contamination — ${algo.name}`,
                records,
                analysis,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            const score = scoreAnalysis(analysis, opts);
            logScore("nap-contamination", score);
            benchmark("nap-contamination", "tauError", score.tauError, 0.04);
            benchmark("nap-contamination", "meanPhaseError", score.meanPhaseError, 0.8);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("nap-contamination", analysis);
            // Catastrophic guards
            expect(score.tauError).toBeLessThan(0.5);
            expect(score.meanPhaseError).toBeLessThan(3.0);
        });
    });

    // ── Benchmark 7: Outlier contamination resistance ───────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: outlier contamination`, () => {
        it("tau error with 20% outliers", () => {
            const opts: SyntheticOptions = {
                tau: 24.5,
                days: 150,
                noise: 0.3,
                outlierFraction: 0.2,
                outlierOffset: 8,
                seed: 700,
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            maybeSaveViz(`scoring_outlier-contamination_${algo.id}`, {
                title: `Outlier contamination 20% — ${algo.name}`,
                records,
                analysis,
                algorithmId: algo.id,
                groundTruth: opts,
            });
            const score = scoreAnalysis(analysis, opts);
            logScore("outlier-contamination", score);
            benchmark("outlier-contamination", "tauError", score.tauError, 0.05);
            benchmark("outlier-contamination", "meanPhaseError", score.meanPhaseError, 0.8);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("outlier-contamination", analysis);
            // Catastrophic guards
            expect(score.tauError).toBeLessThan(0.5);
            expect(score.meanPhaseError).toBeLessThan(3.0);
        });
    });

    // ── Benchmark 8: Forecast accuracy (holdout) ────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: forecast accuracy`, () => {
        it("forecast phase error on 30-day holdout", () => {
            const opts: SyntheticOptions = { tau: 24.5, days: 150, noise: 0.3, seed: 800 };
            const allRecords = generateSyntheticRecords(opts);

            const cutoffDate = new Date("2024-01-01T00:00:00");
            cutoffDate.setDate(cutoffDate.getDate() + 120);
            const trainRecords = allRecords.filter((r) => r.startTime.getTime() < cutoffDate.getTime());

            const analysis = analyze(trainRecords, 30);
            const score = scoreAnalysis(analysis, opts, 120);
            logScore("forecast-holdout", score);
            benchmark("forecast-holdout", "forecastPhaseError", score.forecastPhaseError, 1.5);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("forecast-holdout", analysis);
            // Catastrophic guard
            expect(score.forecastPhaseError).toBeLessThan(5.0);
        });
    });

    // ── Correctness 9: Short dataset graceful degradation ────────────────

    describe(`${algo.name} (${algo.id}) — correctness: short dataset degradation`, () => {
        const lengths = [15, 30, 60, 90, 120];
        const errors: number[] = [];

        for (const days of lengths) {
            it(`${days} days: valid tau in [23.5, 25.5]`, () => {
                const opts: SyntheticOptions = { tau: 24.5, days, noise: 0.3, seed: 900 + days };
                const records = generateSyntheticRecords(opts);
                const analysis = analyze(records);
                const score = scoreAnalysis(analysis, opts);
                logScore(`days=${days}`, score);
                errors.push(score.tauError);
                expect(analysis.globalTau).toBeGreaterThan(23.5);
                expect(analysis.globalTau).toBeLessThan(25.5);
                assertHardDriftLimits(analysis.days);
            });
        }

        it("accuracy improves with more data", () => {
            if (errors.length === lengths.length) {
                benchmark("short-dataset", "improvementCheck", errors[errors.length - 1]!, errors[1]! + 0.05);
                expect(errors[errors.length - 1]!).toBeLessThan(errors[1]! + 0.05);
            }
        });
    });

    // ── Correctness 10: Confidence calibration ───────────────────────────

    describe(`${algo.name} (${algo.id}) — correctness: confidence calibration`, () => {
        it("high-confidence days have lower phase error than low-confidence days", () => {
            const opts: SyntheticOptions = { tau: 24.5, days: 200, noise: 1.5, gapFraction: 0.3, seed: 1000 };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);

            const baseDate = new Date("2024-01-01T00:00:00");
            const bins: { high: number[]; medium: number[]; low: number[] } = {
                high: [],
                medium: [],
                low: [],
            };

            for (const day of analysis.days) {
                if (day.isForecast) continue;
                const d = Math.round((new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000);
                const predictedMid = (day.nightStartHour + day.nightEndHour) / 2;
                const trueMid = computeTrueMidpoint(d, opts);
                const error = circularDistance(predictedMid, trueMid);
                bins[day.confidence].push(error);
            }

            const mean = (arr: number[]) => (arr.length > 0 ? arr.reduce((s, e) => s + e, 0) / arr.length : Infinity);

            const highMean = mean(bins.high);
            const lowMean = mean(bins.low);

            console.log(
                `  confidence calibration: high=${highMean.toFixed(2)} (n=${bins.high.length}), medium=${mean(bins.medium).toFixed(2)} (n=${bins.medium.length}), low=${lowMean.toFixed(2)} (n=${bins.low.length})`
            );

            if (bins.high.length >= 5 && bins.low.length >= 5) {
                expect(highMean).toBeLessThan(lowMean + 0.5);
            }
            const nonEmpty = [bins.high, bins.medium, bins.low].filter((b) => b.length > 0).length;
            expect(nonEmpty).toBeGreaterThanOrEqual(2);
            assertHardDriftLimits(analysis.days);
        });
    });

    // ── Correctness 11: Sleep fragmentation resistance ──────────────────

    describe(`${algo.name} (${algo.id}) — correctness: sleep fragmentation`, () => {
        it("localTau stays bounded during sleep fragmentation", () => {
            const opts: SyntheticOptions = {
                tau: 25.0,
                days: 180,
                noise: 0.3,
                seed: 1100,
                fragmentedPeriod: {
                    startDay: 60,
                    endDay: 120,
                    boutsPerDay: 3,
                    boutDuration: 3.5,
                },
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            maybeSaveViz(`scoring_fragmentation_${algo.id}`, {
                title: `Sleep fragmentation — ${algo.name}`,
                records,
                analysis,
                algorithmId: algo.id,
                groundTruth: opts,
            });

            assertHardDriftLimits(analysis.days);
            logDriftPenalty("fragmentation", analysis);

            const baseDate = new Date("2024-01-01T00:00:00");
            const fragmentedTaus: number[] = [];

            for (const day of analysis.days) {
                if (day.isForecast) continue;
                const d = Math.round((new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000);
                if (d >= 60 && d < 120) {
                    fragmentedTaus.push(day.localTau);
                }
            }

            const meanFragTau = fragmentedTaus.reduce((s, t) => s + t, 0) / fragmentedTaus.length;
            console.log(
                `  fragmentation: mean localTau during fragmented period = ${meanFragTau.toFixed(3)} (true=25.0)`
            );

            benchmark("fragmentation", "localTauCloseness", Math.abs(meanFragTau - 25.0), 0.5);
            expect(Math.abs(meanFragTau - 25.0)).toBeLessThan(2.0);
        });
    });

    // ── Correctness 12: Overlay smoothness ──────────────────────────────

    describe(`${algo.name} (${algo.id}) — correctness: overlay smoothness (synthetic)`, () => {
        /** Circular midpoint from nightStart/nightEnd */
        function overlayMid(day: { nightStartHour: number; nightEndHour: number }): number {
            return ((((day.nightStartHour + day.nightEndHour) / 2) % 24) + 24) % 24;
        }

        /** Compute max day-to-day midpoint jump (circular) across consecutive non-forecast, non-gap days */
        function maxOverlayJump(days: CircadianAnalysis["days"]): { maxJump: number; atDate: string } {
            const data = days.filter((d) => !d.isForecast && !d.isGap);
            let maxJump = 0;
            let atDate = "";
            for (let i = 1; i < data.length; i++) {
                const prevMs = new Date(data[i - 1]!.date + "T00:00:00").getTime();
                const currMs = new Date(data[i]!.date + "T00:00:00").getTime();
                if (Math.round((currMs - prevMs) / 86_400_000) > 1) continue;

                const prev = overlayMid(data[i - 1]!);
                const curr = overlayMid(data[i]!);
                let delta = Math.abs(curr - prev);
                if (delta > 12) delta = 24 - delta;
                if (delta > maxJump) {
                    maxJump = delta;
                    atDate = data[i]!.date;
                }
            }
            return { maxJump, atDate };
        }

        it("no jumps > 3h with clean data", () => {
            const opts: SyntheticOptions = { tau: 25.0, days: 180, noise: 0.3, seed: 1200 };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            const { maxJump, atDate } = maxOverlayJump(analysis.days);
            console.log(`  clean overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
            expect(maxJump).toBeLessThan(3);
            assertHardDriftLimits(analysis.days);
        });

        it("no jumps > 3h with gaps", () => {
            const opts: SyntheticOptions = { tau: 24.5, days: 200, noise: 0.5, gapFraction: 0.3, seed: 1201 };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            const { maxJump, atDate } = maxOverlayJump(analysis.days);
            console.log(`  gapped overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
            expect(maxJump).toBeLessThan(3);
            assertHardDriftLimits(analysis.days);
        });

        it("no jumps > 3h with fragmented sleep", () => {
            const opts: SyntheticOptions = {
                tau: 25.0,
                days: 180,
                noise: 0.3,
                seed: 1202,
                fragmentedPeriod: { startDay: 60, endDay: 120, boutsPerDay: 3, boutDuration: 3.5 },
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            const { maxJump, atDate } = maxOverlayJump(analysis.days);
            console.log(`  fragmented overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
            expect(maxJump).toBeLessThan(3);
            assertHardDriftLimits(analysis.days);
        });

        it("no jumps > 3h with variable tau", () => {
            const opts: SyntheticOptions = {
                tauSegments: [
                    { untilDay: 90, tau: 24.2 },
                    { untilDay: 180, tau: 24.8 },
                ],
                days: 180,
                noise: 0.3,
                seed: 1203,
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);
            const { maxJump, atDate } = maxOverlayJump(analysis.days);
            console.log(`  variable-tau overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
            expect(maxJump).toBeLessThan(3);
            assertHardDriftLimits(analysis.days);
        });
    });

    // ── Cumulative phase shift ────────────────────────────────────────

    describe(`${algo.name} (${algo.id}) — benchmark: cumulative phase shift (synthetic)`, () => {
        function overlayMid(day: { nightStartHour: number; nightEndHour: number }): number {
            return ((((day.nightStartHour + day.nightEndHour) / 2) % 24) + 24) % 24;
        }

        function cumulativeShiftHours(days: CircadianAnalysis["days"]): number {
            const data = days.filter((d) => !d.isForecast && !d.isGap);
            if (data.length < 2) return 0;
            let prevMid = overlayMid(data[0]!);
            let accumulated = 0;
            for (let i = 1; i < data.length; i++) {
                const prevMs = new Date(data[i - 1]!.date + "T00:00:00").getTime();
                const currMs = new Date(data[i]!.date + "T00:00:00").getTime();
                const dayGap = Math.round((currMs - prevMs) / 86_400_000);

                const mid = overlayMid(data[i]!);
                if (dayGap > 1) {
                    prevMid = mid;
                    continue;
                }
                let delta = mid - prevMid;
                if (delta > 12) delta -= 24;
                if (delta < -12) delta += 24;
                accumulated += delta;
                prevMid = mid;
            }
            return accumulated;
        }

        function shiftToTau(shiftHours: number, numDays: number): number {
            const revolutions = Math.abs(shiftHours / 24);
            if (revolutions < 0.1) return 24;
            return (24 * numDays) / (numDays - Math.sign(shiftHours) * revolutions);
        }

        const cases: { tau: number; days: number }[] = [
            { tau: 24.0, days: 180 },
            { tau: 24.5, days: 180 },
            { tau: 25.0, days: 180 },
            { tau: 25.0, days: 90 },
        ];

        for (const { tau, days } of cases) {
            it(`tau=${tau}, ${days}d: overlay shift vs expected`, () => {
                const opts: SyntheticOptions = {
                    tau,
                    days,
                    noise: 0.3,
                    seed: 1500 + Math.round(tau * 100) + days,
                };
                const records = generateSyntheticRecords(opts);
                const analysis = analyze(records);

                const dataDays = analysis.days.filter((d) => !d.isForecast);
                const expectedShiftH = (tau - 24) * dataDays.length;
                const actualShiftH = cumulativeShiftHours(analysis.days);
                const impliedTau = shiftToTau(actualShiftH, dataDays.length);

                console.log(
                    `  tau=${tau} ${days}d: expected=${expectedShiftH.toFixed(1)}h actual=${actualShiftH.toFixed(1)}h impliedTau=${impliedTau.toFixed(4)}`
                );

                assertHardDriftLimits(analysis.days);
                logDriftPenalty(`cumshift/${tau}/${days}d`, analysis);

                if (Math.abs(expectedShiftH) < 1) {
                    benchmark(`cumshift/${tau}/${days}d`, "absShiftError", Math.abs(actualShiftH - expectedShiftH), 5);
                    expect(Math.abs(actualShiftH - expectedShiftH)).toBeLessThan(15);
                } else {
                    const ratio = actualShiftH / expectedShiftH;
                    benchmark(`cumshift/${tau}/${days}d`, "shiftRatio", ratio, 1.15);
                    expect(ratio).toBeGreaterThan(0.5);
                    expect(ratio).toBeLessThan(1.5);
                }
            });
        }

        it("fragmented period preserves cumulative shift", () => {
            const tau = 25.0;
            const opts: SyntheticOptions = {
                tau,
                days: 180,
                noise: 0.3,
                seed: 1550,
                fragmentedPeriod: { startDay: 60, endDay: 120, boutsPerDay: 3, boutDuration: 3.5 },
            };
            const records = generateSyntheticRecords(opts);
            const analysis = analyze(records);

            const dataDays = analysis.days.filter((d) => !d.isForecast);
            const expectedShiftH = (tau - 24) * dataDays.length;
            const actualShiftH = cumulativeShiftHours(analysis.days);
            const impliedTau = shiftToTau(actualShiftH, dataDays.length);

            console.log(
                `  fragmented: expected=${expectedShiftH.toFixed(1)}h actual=${actualShiftH.toFixed(1)}h impliedTau=${impliedTau.toFixed(4)}`
            );

            const ratio = actualShiftH / expectedShiftH;
            benchmark("cumshift/fragmented", "shiftRatio", ratio, 1.15);
            assertHardDriftLimits(analysis.days);
            logDriftPenalty("cumshift/fragmented", analysis);
            expect(ratio).toBeGreaterThan(0.5);
            expect(ratio).toBeLessThan(1.5);
        });
    });
}

// ── Regression-only: Benchmark 16 — Overlay shift vs periodogram (real data) ─

describe.skipIf(!hasRealData(AOZORA_FILE))(
    "regression-v1 — benchmark: cumulative shift vs periodogram (real data)",
    () => {
        /** Circular midpoint from nightStart/nightEnd */
        function overlayMid(day: { nightStartHour: number; nightEndHour: number }): number {
            return ((((day.nightStartHour + day.nightEndHour) / 2) % 24) + 24) % 24;
        }

        function cumulativeShiftHours(days: CircadianAnalysis["days"]): number {
            const data = days.filter((d) => !d.isForecast && !d.isGap);
            if (data.length < 2) return 0;
            let prevMid = overlayMid(data[0]!);
            let accumulated = 0;
            for (let i = 1; i < data.length; i++) {
                const prevMs = new Date(data[i - 1]!.date + "T00:00:00").getTime();
                const currMs = new Date(data[i]!.date + "T00:00:00").getTime();
                const dayGap = Math.round((currMs - prevMs) / 86_400_000);

                const mid = overlayMid(data[i]!);
                if (dayGap > 1) {
                    prevMid = mid;
                    continue;
                }
                let delta = mid - prevMid;
                if (delta > 12) delta -= 24;
                if (delta < -12) delta += 24;
                accumulated += delta;
                prevMid = mid;
            }
            return accumulated;
        }

        function shiftToTau(shiftHours: number, numDays: number): number {
            const revolutions = Math.abs(shiftHours / 24);
            if (revolutions < 0.1) return 24;
            return (24 * numDays) / (numDays - Math.sign(shiftHours) * revolutions);
        }

        it("overlay implied tau vs periodogram peak", () => {
            const records = loadRealData(AOZORA_FILE);
            const analysis = analyzeWithAlgorithm("regression-v1", records) as RegressionAnalysis;
            const periodogram = computePeriodogram(analysis.anchors);

            const dataDays = analysis.days.filter((d) => !d.isForecast);
            const numDays = dataDays.length;
            const actualShiftH = cumulativeShiftHours(analysis.days);
            const overlayTau = shiftToTau(actualShiftH, numDays);

            const peakTau = periodogram.peakPeriod;
            const expectedShiftH = (peakTau - 24) * numDays;

            const overlayDrift = overlayTau - 24;
            const periodogramDrift = peakTau - 24;

            console.log(
                `  periodogram peak: ${peakTau.toFixed(4)}h (power=${periodogram.peakPower.toFixed(3)}, sig=${periodogram.significanceThreshold.toFixed(3)})`
            );
            console.log(`  overlay: shift=${actualShiftH.toFixed(1)}h impliedTau=${overlayTau.toFixed(4)}`);
            console.log(`  expected shift: ${expectedShiftH.toFixed(1)}h`);
            console.log(
                `  drift comparison: overlay=${overlayDrift.toFixed(4)} periodogram=${periodogramDrift.toFixed(4)} ratio=${(overlayDrift / periodogramDrift).toFixed(3)}`
            );

            assertHardDriftLimits(analysis.days);
            logDriftPenalty("periodogram-comparison", analysis);

            if (periodogramDrift > 0.05) {
                const driftRatio = overlayDrift / periodogramDrift;
                benchmark("periodogram", "driftRatio", driftRatio, 1.15);
                expect(driftRatio).toBeGreaterThan(0.5);
                expect(driftRatio).toBeLessThan(1.5);
            }
        });
    }
);
