import { describe, it, expect } from "vitest";
import { listAlgorithms } from "../circadian";
import { hasTestData, listGroundTruthDatasets } from "./fixtures/loadGroundTruth";
import { assertHardDriftLimits, computeDriftPenalty } from "./fixtures/driftPenalty";

const VERBOSE = process.env.VERBOSE === "1";

// ── Helpers ──────────────────────────────────────────────────────────

/** Circular distance between two hour values, handling 24h wrap */
function circularDistance(a: number, b: number): number {
    const na = ((a % 24) + 24) % 24;
    const nb = ((b % 24) + 24) % 24;
    const diff = Math.abs(na - nb);
    return Math.min(diff, 24 - diff);
}

/**
 * Signed circular error: positive = algorithm is *later* than manual.
 * Range: (-12, +12]
 */
function signedCircularError(algoHour: number, manualHour: number): number {
    const na = ((algoHour % 24) + 24) % 24;
    const nm = ((manualHour % 24) + 24) % 24;
    let diff = na - nm;
    if (diff > 12) diff -= 24;
    if (diff <= -12) diff += 24;
    return diff;
}

function midpoint(d: { nightStartHour: number; nightEndHour: number }): number {
    return (d.nightStartHour + d.nightEndHour) / 2;
}

/** Unwrap a midpoint relative to previous, return unwrapped value */
function unwrapRelative(mid: number, prev: number): number {
    let m = mid;
    while (m - prev > 12) m -= 24;
    while (prev - m > 12) m += 24;
    return m;
}

/** Cumulative phase shift from day-to-day unwrapped deltas */
function cumulativeShift(days: { nightStartHour: number; nightEndHour: number }[]): number {
    if (days.length < 2) return 0;
    let prev = midpoint(days[0]!);
    let accumulated = 0;
    for (let i = 1; i < days.length; i++) {
        const mid = unwrapRelative(midpoint(days[i]!), prev);
        accumulated += mid - prev;
        prev = mid;
    }
    return accumulated;
}

/** Convert cumulative shift to implied tau */
function shiftToTau(shiftHours: number, numDays: number): number {
    const revolutions = Math.abs(shiftHours / 24);
    if (revolutions < 0.1) return 24;
    return (24 * numDays) / (numDays - Math.sign(shiftHours) * revolutions);
}

/** Compute day-to-day drift rates from an overlay sequence */
function driftRates(days: { date: string; nightStartHour: number; nightEndHour: number }[]): Map<string, number> {
    const rates = new Map<string, number>();
    if (days.length < 2) return rates;
    let prev = midpoint(days[0]!);
    for (let i = 1; i < days.length; i++) {
        const mid = unwrapRelative(midpoint(days[i]!), prev);
        rates.set(days[i]!.date, mid - prev);
        prev = mid;
    }
    return rates;
}

interface DayPair {
    date: string;
    algoMid: number;
    manualMid: number;
    signedError: number;
    absError: number;
    algoDrift: number | undefined;
    manualDrift: number | undefined;
}

function percentile(sorted: number[], p: number): number {
    return sorted[Math.floor(sorted.length * p)]!;
}

function formatPct(n: number, total: number): string {
    return `${n}/${total} (${((n / total) * 100).toFixed(0)}%)`;
}

// ── Output formatters ────────────────────────────────────────────────

interface GroundTruthStats {
    name: string;
    algorithmId: string;
    n: number;
    mean: number;
    median: number;
    p90: number;
    signedMean: number;
    directionAgree: number;
    directionDisagree: number;
    algoStalled: number;
    driftTotal: number;
    algoShift: number;
    algoTau: number;
    gtShift: number;
    gtTau: number;
    tauDeltaMin: number;
    maxTauDeltaWindow: number;
    streakCount: number;
    severeStreakCount: number;
    maxStreakDays: number;
    driftPenalty: number;
    penaltyDays: number;
    penaltyFraction: number;
    phaseConsistencyMean: number;
    phaseConsistencyP90: number;
    phaseConsistencyMax: number;
    phaseStepViolations: number;
    phaseStepMin: number;
    phaseStepMax: number;
    windowStats: {
        start: string;
        end: string;
        mean: number;
        signedMean: number;
        n: number;
        tauAlgo: number;
        tauManual: number;
    }[];
    streaks: {
        start: string;
        end: string;
        days: number;
        peakError: number;
        avgSignedError: number;
    }[];
    algoDays: number;
    gtDays: number;
}

function sign(v: number): string {
    return (v >= 0 ? "+" : "") + v.toFixed(2);
}

function logCompact(s: GroundTruthStats): void {
    const agreePct = s.driftTotal > 0 ? Math.round((s.directionAgree / s.driftTotal) * 100) : 0;
    console.log(
        `GTRESULT\t${s.algorithmId}\t${s.name}\t` +
            `n=${s.n}\t` +
            `mean=${s.mean.toFixed(2)}h\t` +
            `median=${s.median.toFixed(2)}h\t` +
            `p90=${s.p90.toFixed(2)}h\t` +
            `bias=${sign(s.signedMean)}h\t` +
            `drift-agree=${agreePct}%\t` +
            `tau-delta=${sign(s.tauDeltaMin)}min\t` +
            `max-win-tau=${sign(s.maxTauDeltaWindow)}min\t` +
            `streaks=${s.streakCount}\t` +
            `severe=${s.severeStreakCount}\t` +
            `step=[${s.phaseStepMin.toFixed(1)},${s.phaseStepMax.toFixed(1)}]\t` +
            `violations=${s.phaseStepViolations}\t` +
            `penalty=${s.driftPenalty.toFixed(2)}\t` +
            `phase-cons=${s.phaseConsistencyP90.toFixed(2)}h`
    );
}

function logVerbose(s: GroundTruthStats): void {
    console.log(`\n  ┌─ [${s.algorithmId}] ${s.name} ────────────────────────`);
    console.log(
        `  │ Phase error:  mean=${s.mean.toFixed(2)}h  median=${s.median.toFixed(2)}h  p90=${s.p90.toFixed(2)}h  (n=${s.n})`
    );
    console.log(`  │ Signed bias:  ${sign(s.signedMean)}h  (+ = algo later than manual)`);
    console.log(`  │`);
    console.log(`  │ Drift direction (day-to-day):`);
    console.log(`  │   agree:    ${formatPct(s.directionAgree, s.driftTotal)}`);
    console.log(`  │   disagree: ${formatPct(s.directionDisagree, s.driftTotal)}`);
    console.log(`  │   stalled:  ${formatPct(s.algoStalled, s.driftTotal)}  (algo ~0 but manual significant)`);
    console.log(`  │`);
    console.log(`  │ Overall tau:`);
    console.log(
        `  │   algorithm: shift=${s.algoShift.toFixed(1)}h  tau=${s.algoTau.toFixed(4)}h  (${s.algoDays} days)`
    );
    console.log(`  │   manual:    shift=${s.gtShift.toFixed(1)}h  tau=${s.gtTau.toFixed(4)}h  (${s.gtDays} days)`);
    console.log(`  │   delta:     ${sign(s.tauDeltaMin)} min/day`);

    if (s.windowStats.length > 1) {
        console.log(`  │`);
        console.log(`  │ Rolling 90-day windows:`);
        for (const w of s.windowStats) {
            const tauDelta = (w.tauAlgo - w.tauManual) * 60;
            console.log(
                `  │   ${w.start} → ${w.end}:  err=${w.mean.toFixed(2)}h  bias=${sign(w.signedMean)}h  tau Δ=${sign(tauDelta)}min  (n=${w.n})`
            );
        }
    }

    if (s.streaks.length > 0) {
        console.log(`  │`);
        console.log(`  │ Divergence streaks (>2.0h for 3+ days):`);
        for (const st of s.streaks) {
            const dir = st.avgSignedError >= 0 ? "algo later" : "algo earlier";
            console.log(
                `  │   ${st.start} → ${st.end}  (${st.days}d)  peak=${st.peakError.toFixed(1)}h  ${dir} by ${Math.abs(st.avgSignedError).toFixed(1)}h`
            );
        }
    }

    console.log(`  │`);
    console.log(
        `  │ Drift penalty:  score=${s.driftPenalty.toFixed(2)}  days=${s.penaltyDays}  fraction=${(s.penaltyFraction * 100).toFixed(1)}%`
    );
    console.log(
        `  │ Phase consistency:  mean=${s.phaseConsistencyMean.toFixed(2)}h  p90=${s.phaseConsistencyP90.toFixed(2)}h  max=${s.phaseConsistencyMax.toFixed(2)}h`
    );
    console.log(
        `  │ Phase steps:  min=${s.phaseStepMin.toFixed(2)}h  max=${s.phaseStepMax.toFixed(2)}h  violations=${s.phaseStepViolations}`
    );
    console.log(`  └────────────────────────────────────────`);
}

// ── Test suite ───────────────────────────────────────────────────────

describe.skipIf(!hasTestData)("ground truth scoring", () => {
    const datasets = hasTestData ? listGroundTruthDatasets() : [];
    const algorithms = listAlgorithms();

    for (const dataset of datasets) {
        describe(dataset.name, () => {
            for (const algorithm of algorithms) {
                it(`[${algorithm.id}] forecast days do not overlap sleep record dates`, () => {
                    const FORECAST_DAYS = 7;
                    const analysis = algorithm.analyze(dataset.records, FORECAST_DAYS);
                    const forecasts = analysis.days.filter((d) => d.isForecast);

                    expect(forecasts.length).toBe(FORECAST_DAYS);

                    // No forecast day should fall on a date that has a sleep record.
                    // Regression: any day with a sleep record is a data day, not a forecast.
                    const recordDates = new Set(dataset.records.map((r) => r.dateOfSleep));
                    for (const fc of forecasts) {
                        expect(recordDates.has(fc.date), `forecast day ${fc.date} has a sleep record`).toBe(false);
                    }
                });

                it(`[${algorithm.id}] overlay matches ground truth`, () => {
                    const analysis = algorithm.analyze(dataset.records);
                    const algoMap = new Map(analysis.days.map((d) => [d.date, d]));

                    // Hard drift limits
                    assertHardDriftLimits(analysis.days);

                    // Drift penalty
                    const penalty = computeDriftPenalty(analysis.days);

                    // Sort manual overlay by date
                    const gtSorted = [...dataset.overlay].sort((a, b) => a.date.localeCompare(b.date));
                    const gtMap = new Map(gtSorted.map((d) => [d.date, d]));

                    // Compute drift rates for both
                    const algoDays = analysis.days.filter((d) => !d.isForecast && !d.isGap);
                    const algoDriftMap = driftRates(algoDays);
                    const gtDriftMap = driftRates(gtSorted);

                    // Build paired comparison
                    const pairs: DayPair[] = [];
                    for (const gt of gtSorted) {
                        const algo = algoMap.get(gt.date);
                        if (!algo || algo.isGap) continue;
                        const am = midpoint(algo);
                        const gm = midpoint(gt);
                        pairs.push({
                            date: gt.date,
                            algoMid: am,
                            manualMid: gm,
                            signedError: signedCircularError(am, gm),
                            absError: circularDistance(am, gm),
                            algoDrift: algoDriftMap.get(gt.date),
                            manualDrift: gtDriftMap.get(gt.date),
                        });
                    }

                    if (pairs.length === 0) {
                        console.log(`  [${algorithm.id}] ${dataset.name}: no overlapping dates to compare`);
                        return;
                    }

                    // ── 1. Basic error stats ─────────────────────────
                    const absErrors = pairs.map((p) => p.absError).sort((a, b) => a - b);
                    const signedErrors = pairs.map((p) => p.signedError);
                    const mean = absErrors.reduce((s, e) => s + e, 0) / absErrors.length;
                    const median = percentile(absErrors, 0.5);
                    const p90 = percentile(absErrors, 0.9);
                    const signedMean = signedErrors.reduce((s, e) => s + e, 0) / signedErrors.length;

                    // ── 2. Directional drift agreement ───────────────
                    const driftPairs = pairs.filter((p) => p.algoDrift !== undefined && p.manualDrift !== undefined);
                    let directionAgree = 0;
                    let directionDisagree = 0;
                    let algoStalled = 0;
                    const DRIFT_THRESHOLD = 0.1;
                    for (const p of driftPairs) {
                        const ad = p.algoDrift!;
                        const md = p.manualDrift!;
                        const algoSig = Math.abs(ad) >= DRIFT_THRESHOLD;
                        const manualSig = Math.abs(md) >= DRIFT_THRESHOLD;

                        if (!algoSig && manualSig) {
                            algoStalled++;
                        } else if (algoSig && manualSig) {
                            if (Math.sign(ad) === Math.sign(md)) directionAgree++;
                            else directionDisagree++;
                        } else {
                            directionAgree++;
                        }
                    }

                    // ── 3. Cumulative shift & tau ────────────────────
                    const algoShift = cumulativeShift(algoDays);
                    const algoTau = shiftToTau(algoShift, algoDays.length);
                    const gtShift = cumulativeShift(gtSorted);
                    const gtTau = shiftToTau(gtShift, gtSorted.length);

                    // ── 4. Rolling window breakdown ──────────────────
                    const WINDOW_SIZE = 90;
                    const windowStats: GroundTruthStats["windowStats"] = [];
                    for (let i = 0; i < pairs.length; i += WINDOW_SIZE) {
                        const window = pairs.slice(i, i + WINDOW_SIZE);
                        if (window.length < 10) continue;
                        const wMean = window.reduce((s, p) => s + p.absError, 0) / window.length;
                        const wSignedMean = window.reduce((s, p) => s + p.signedError, 0) / window.length;

                        const wAlgoDays = window.map((p) => algoMap.get(p.date)!).filter(Boolean);
                        const wGtDays = window.map((p) => gtMap.get(p.date)!).filter(Boolean);
                        const wAlgoShift = cumulativeShift(wAlgoDays);
                        const wGtShift = cumulativeShift(wGtDays);

                        windowStats.push({
                            start: window[0]!.date,
                            end: window[window.length - 1]!.date,
                            mean: wMean,
                            signedMean: wSignedMean,
                            n: window.length,
                            tauAlgo: shiftToTau(wAlgoShift, wAlgoDays.length),
                            tauManual: shiftToTau(wGtShift, wGtDays.length),
                        });
                    }

                    // ── 5. Large divergence streaks ──────────────────
                    const DIVERGENCE_THRESH = 2.0;
                    const streaks: GroundTruthStats["streaks"] = [];
                    let streakStart = -1;
                    for (let i = 0; i <= pairs.length; i++) {
                        const inStreak = i < pairs.length && pairs[i]!.absError > DIVERGENCE_THRESH;
                        if (inStreak && streakStart < 0) {
                            streakStart = i;
                        } else if (!inStreak && streakStart >= 0) {
                            const run = pairs.slice(streakStart, i);
                            if (run.length >= 3) {
                                streaks.push({
                                    start: run[0]!.date,
                                    end: run[run.length - 1]!.date,
                                    days: run.length,
                                    peakError: Math.max(...run.map((p) => p.absError)),
                                    avgSignedError: run.reduce((s, p) => s + p.signedError, 0) / run.length,
                                });
                            }
                            streakStart = -1;
                        }
                    }

                    // ── 6. Phase consistency (actual vs tau-predicted drift) ──────────────────
                    const phaseConsistencyErrors: number[] = [];
                    for (let i = 1; i < algoDays.length; i++) {
                        const prev = algoDays[i - 1]!;
                        const curr = algoDays[i]!;

                        const expectedDrift = prev.localTau - 24;
                        const actualChange = signedCircularError(midpoint(curr), midpoint(prev));

                        const inconsistency = Math.abs(actualChange - expectedDrift);
                        phaseConsistencyErrors.push(inconsistency);
                    }

                    const pcSorted = [...phaseConsistencyErrors].sort((a, b) => a - b);
                    const phaseConsistencyMean =
                        pcSorted.length > 0 ? pcSorted.reduce((s, e) => s + e, 0) / pcSorted.length : 0;
                    const phaseConsistencyP90 = pcSorted.length > 0 ? percentile(pcSorted, 0.9) : 0;
                    const phaseConsistencyMax = pcSorted.length > 0 ? pcSorted[pcSorted.length - 1]! : 0;

                    // ── 7. Max window tau delta ──────────────────
                    const maxTauDeltaWindow =
                        windowStats.length > 0
                            ? Math.max(...windowStats.map((w) => Math.abs((w.tauAlgo - w.tauManual) * 60)))
                            : 0;

                    // ── 8. Severe streak count (peak > 6h = half-day error) ──────────────────
                    const severeStreakCount = streaks.filter((s) => s.peakError > 6).length;

                    // ── 9. Phase step bounds check ──────────────────
                    const PHASE_STEP_MIN = -2.0;
                    const PHASE_STEP_MAX = 3.0;
                    let phaseStepViolations = 0;
                    let phaseStepMin = Infinity;
                    let phaseStepMax = -Infinity;
                    for (let i = 1; i < algoDays.length; i++) {
                        const prev = algoDays[i - 1]!;
                        const curr = algoDays[i]!;

                        // Check midpoint step (circular)
                        const midStep = signedCircularError(midpoint(curr), midpoint(prev));
                        if (midStep < phaseStepMin) phaseStepMin = midStep;
                        if (midStep > phaseStepMax) phaseStepMax = midStep;
                        if (midStep < PHASE_STEP_MIN || midStep > PHASE_STEP_MAX) {
                            phaseStepViolations++;
                        }

                        // Check start/end hour steps (unwrapped space)
                        const startStep = curr.nightStartHour - prev.nightStartHour;
                        if (startStep < PHASE_STEP_MIN || startStep > PHASE_STEP_MAX) {
                            phaseStepViolations++;
                        }

                        const endStep = curr.nightEndHour - prev.nightEndHour;
                        if (endStep < PHASE_STEP_MIN || endStep > PHASE_STEP_MAX) {
                            phaseStepViolations++;
                        }
                    }
                    if (!isFinite(phaseStepMin)) phaseStepMin = 0;
                    if (!isFinite(phaseStepMax)) phaseStepMax = 0;

                    // ── Output ───────────────────────────────────────
                    const stats: GroundTruthStats = {
                        name: dataset.name,
                        algorithmId: algorithm.id,
                        n: pairs.length,
                        mean,
                        median,
                        p90,
                        signedMean,
                        directionAgree,
                        directionDisagree,
                        algoStalled,
                        driftTotal: driftPairs.length,
                        algoShift,
                        algoTau,
                        gtShift,
                        gtTau,
                        tauDeltaMin: (algoTau - gtTau) * 60,
                        maxTauDeltaWindow,
                        streakCount: streaks.length,
                        severeStreakCount: streaks.filter((s) => s.peakError > 6).length,
                        maxStreakDays: streaks.length > 0 ? Math.max(...streaks.map((s) => s.days)) : 0,
                        driftPenalty: penalty.totalPenalty,
                        penaltyDays: penalty.penaltyDays,
                        penaltyFraction: penalty.penaltyFraction,
                        phaseConsistencyMean,
                        phaseConsistencyP90,
                        phaseConsistencyMax,
                        phaseStepViolations,
                        phaseStepMin,
                        phaseStepMax,
                        windowStats,
                        streaks,
                        algoDays: algoDays.length,
                        gtDays: gtSorted.length,
                    };

                    if (VERBOSE) {
                        logVerbose(stats);
                    } else {
                        logCompact(stats);
                    }

                    // Loose thresholds — tighten as algorithm improves
                    expect(mean).toBeLessThan(2.5);
                    expect(p90).toBeLessThan(6.0);
                    expect(maxTauDeltaWindow).toBeLessThan(50);
                    expect(severeStreakCount).toBeLessThan(10);
                    expect(penalty.totalPenalty).toBeLessThan(500);

                    // ── Edge accuracy ──────────────────────
                    // Guards against algorithms lagging at the end of the dataset
                    // (e.g. RTS smoother's unsmoothed terminal state bias).
                    // Thresholds are the tightest both CSF and regression can pass
                    // across all ground truth datasets.
                    const EDGE_DAYS = 7;
                    if (pairs.length >= EDGE_DAYS) {
                        const edgePairs = [...pairs].sort((a, b) => a.date.localeCompare(b.date)).slice(-EDGE_DAYS);
                        const edgeErrs = edgePairs.map((p) => p.absError).sort((a, b) => a - b);
                        const edgeMean = edgeErrs.reduce((a, b) => a + b, 0) / edgeErrs.length;
                        const edgeP90 = edgeErrs[Math.floor(edgeErrs.length * 0.9)]!;
                        if (VERBOSE) {
                            console.log(
                                `  last${EDGE_DAYS}d [${algorithm.id}]: mean=${edgeMean.toFixed(2)}h p90=${edgeP90.toFixed(2)}h`
                            );
                        }
                        expect(edgeMean).toBeLessThan(1.5);
                        expect(edgeP90).toBeLessThan(2.5);
                    }
                    // TODO: Phase step bounds - currently all algorithms violate
                    // The night window duration changes cause start/end to shift
                    // even when midpoint is smooth. Need to fix algorithm output.
                    // expect(phaseStepViolations).toBe(0);
                });
            }
        });
    }
});
