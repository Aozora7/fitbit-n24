import { describe, it, expect } from "vitest";
import { analyzeCircadian } from "../circadian";
import { hasTestData, listGroundTruthDatasets } from "./fixtures/loadGroundTruth";

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

// ── Test suite ───────────────────────────────────────────────────────

describe.skipIf(!hasTestData)("ground truth scoring", () => {
    const datasets = hasTestData ? listGroundTruthDatasets() : [];

    for (const dataset of datasets) {
        describe(dataset.name, () => {
            it("algorithm overlay matches ground truth", () => {
                const analysis = analyzeCircadian(dataset.records);
                const algoMap = new Map(analysis.days.map((d) => [d.date, d]));

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
                    console.log(`  ${dataset.name}: no overlapping dates to compare`);
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
                // For days where both algo and manual have a drift rate,
                // check if they agree on direction (both positive = later, both negative = earlier)
                const driftPairs = pairs.filter((p) => p.algoDrift !== undefined && p.manualDrift !== undefined);
                let directionAgree = 0;
                let directionDisagree = 0;
                let algoStalled = 0; // algo says ~0 drift but manual says significant
                const DRIFT_THRESHOLD = 0.1; // h/day: below this is "stalled"
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
                        directionAgree++; // both stalled or only algo significant
                    }
                }

                // ── 3. Cumulative shift & tau ────────────────────
                const algoShift = cumulativeShift(algoDays);
                const algoTau = shiftToTau(algoShift, algoDays.length);
                const gtShift = cumulativeShift(gtSorted);
                const gtTau = shiftToTau(gtShift, gtSorted.length);

                // ── 4. Rolling window breakdown ──────────────────
                // 90-day windows to show where divergence happens
                const WINDOW_SIZE = 90;
                const windowStats: {
                    start: string;
                    end: string;
                    mean: number;
                    signedMean: number;
                    n: number;
                    tauAlgo: number;
                    tauManual: number;
                }[] = [];
                for (let i = 0; i < pairs.length; i += WINDOW_SIZE) {
                    const window = pairs.slice(i, i + WINDOW_SIZE);
                    if (window.length < 10) continue;
                    const wMean = window.reduce((s, p) => s + p.absError, 0) / window.length;
                    const wSignedMean = window.reduce((s, p) => s + p.signedError, 0) / window.length;

                    // Window tau from paired days
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
                // Find consecutive runs where error > 2h
                const DIVERGENCE_THRESH = 2.0;
                const streaks: {
                    start: string;
                    end: string;
                    days: number;
                    peakError: number;
                    avgSignedError: number;
                }[] = [];
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

                // ── Output ───────────────────────────────────────
                console.log(`\n  ┌─ ${dataset.name} ────────────────────────`);
                console.log(
                    `  │ Phase error:  mean=${mean.toFixed(2)}h  median=${median.toFixed(2)}h  p90=${p90.toFixed(2)}h  (n=${pairs.length})`
                );
                console.log(
                    `  │ Signed bias:  ${signedMean >= 0 ? "+" : ""}${signedMean.toFixed(2)}h  (+ = algo later than manual)`
                );
                console.log(`  │`);
                console.log(`  │ Drift direction (day-to-day):`);
                console.log(`  │   agree:    ${formatPct(directionAgree, driftPairs.length)}`);
                console.log(`  │   disagree: ${formatPct(directionDisagree, driftPairs.length)}`);
                console.log(
                    `  │   stalled:  ${formatPct(algoStalled, driftPairs.length)}  (algo ~0 but manual significant)`
                );
                console.log(`  │`);
                console.log(`  │ Overall tau:`);
                console.log(
                    `  │   algorithm: shift=${algoShift.toFixed(1)}h  tau=${algoTau.toFixed(4)}h  (${algoDays.length} days)`
                );
                console.log(
                    `  │   manual:    shift=${gtShift.toFixed(1)}h  tau=${gtTau.toFixed(4)}h  (${gtSorted.length} days)`
                );
                console.log(
                    `  │   delta:     ${algoTau - gtTau >= 0 ? "+" : ""}${((algoTau - gtTau) * 60).toFixed(1)} min/day`
                );

                if (windowStats.length > 1) {
                    console.log(`  │`);
                    console.log(`  │ Rolling ${WINDOW_SIZE}-day windows:`);
                    for (const w of windowStats) {
                        const tauDelta = (w.tauAlgo - w.tauManual) * 60;
                        console.log(
                            `  │   ${w.start} → ${w.end}:  err=${w.mean.toFixed(2)}h  bias=${w.signedMean >= 0 ? "+" : ""}${w.signedMean.toFixed(2)}h  tau Δ=${tauDelta >= 0 ? "+" : ""}${tauDelta.toFixed(1)}min  (n=${w.n})`
                        );
                    }
                }

                if (streaks.length > 0) {
                    console.log(`  │`);
                    console.log(`  │ Divergence streaks (>${DIVERGENCE_THRESH}h for 3+ days):`);
                    for (const s of streaks) {
                        const dir = s.avgSignedError >= 0 ? "algo later" : "algo earlier";
                        console.log(
                            `  │   ${s.start} → ${s.end}  (${s.days}d)  peak=${s.peakError.toFixed(1)}h  ${dir} by ${Math.abs(s.avgSignedError).toFixed(1)}h`
                        );
                    }
                }

                console.log(`  └────────────────────────────────────────`);

                // Loose thresholds — tighten as algorithm improves
                expect(mean).toBeLessThan(3.0);
                expect(p90).toBeLessThan(6.0);
            });
        });
    }
});
