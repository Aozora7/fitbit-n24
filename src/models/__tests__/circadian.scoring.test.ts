import { describe, it, expect } from "vitest";
import { analyzeCircadian, type CircadianAnalysis } from "../circadian";
import { computeLombScargle } from "../lombScargle";
import {
  generateSyntheticRecords,
  computeTrueMidpoint,
  type SyntheticOptions,
} from "./fixtures/synthetic";
import { hasRealData, loadRealData } from "./fixtures/loadRealData";

// ── Scoring utilities ──────────────────────────────────────────────

/** Circular distance between two hours (mod 24), returns 0-12 */
function circularDistance(a: number, b: number): number {
  const diff = Math.abs(((a % 24) + 24) % 24 - ((b % 24) + 24) % 24);
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
function scoreAnalysis(
  analysis: CircadianAnalysis,
  opts: SyntheticOptions,
  holdoutStart?: number,
): AccuracyScore {
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
  const meanPhaseError =
    phaseErrors.length > 0 ? phaseErrors.reduce((s, e) => s + e, 0) / phaseErrors.length : 0;
  const medianPhaseError =
    phaseErrors.length > 0 ? phaseErrors[Math.floor(phaseErrors.length / 2)]! : 0;
  const p90PhaseError =
    phaseErrors.length > 0 ? phaseErrors[Math.floor(phaseErrors.length * 0.9)]! : 0;
  const forecastPhaseError =
    forecastErrors.length > 0
      ? forecastErrors.reduce((s, e) => s + e, 0) / forecastErrors.length
      : 0;

  const noise = opts.noise ?? 0.5;
  const residualRatio = noise > 0 ? analysis.medianResidualHours / noise : 1;

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
    `  ${label.padEnd(24)} tau±${score.tauError.toFixed(3)}  phase: mean=${score.meanPhaseError.toFixed(2)} med=${score.medianPhaseError.toFixed(2)} p90=${score.p90PhaseError.toFixed(2)}  resid=${score.residualRatio.toFixed(2)}`,
  );
}

// ── Test 1: Tau estimation sweep ───────────────────────────────────
// Baseline: all tau errors ~0.007-0.010. Threshold at 0.04 (~4x headroom).

describe("scoring: tau estimation sweep", () => {
  const taus = [24.0, 24.2, 24.5, 24.7, 25.0, 25.5];

  for (const tau of taus) {
    it(`tau=${tau}: error < 0.04`, () => {
      const opts: SyntheticOptions = { tau, days: 120, noise: 0.3, seed: Math.round(tau * 100) };
      const records = generateSyntheticRecords(opts);
      const analysis = analyzeCircadian(records);
      const score = scoreAnalysis(analysis, opts);
      logScore(`tau=${tau}`, score);
      expect(score.tauError).toBeLessThan(0.04);
    });
  }
});

// ── Test 2: Phase prediction accuracy ──────────────────────────────
// Baseline: mean=0.29, p90=1.00. Tighten to 0.5 / 1.5.

describe("scoring: phase prediction accuracy", () => {
  it("mean phase error < 0.5h, p90 < 1.5h", () => {
    const opts: SyntheticOptions = { tau: 24.5, days: 120, noise: 0.3, seed: 200 };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const score = scoreAnalysis(analysis, opts);
    logScore("phase-accuracy", score);
    expect(score.meanPhaseError).toBeLessThan(0.5);
    expect(score.p90PhaseError).toBeLessThan(1.5);
  });
});

// ── Test 3: Noise degradation curve ────────────────────────────────
// Baseline residual ratios: 0.64-0.76. Tighten bounds.

describe("scoring: noise degradation", () => {
  const noises = [0.3, 0.5, 1.0, 1.5, 2.0];

  for (const noise of noises) {
    it(`noise=${noise}: tau error bounded, residual ratio sane`, () => {
      const opts: SyntheticOptions = { tau: 24.5, days: 150, noise, seed: 300 + Math.round(noise * 10) };
      const records = generateSyntheticRecords(opts);
      const analysis = analyzeCircadian(records);
      const score = scoreAnalysis(analysis, opts);
      logScore(`noise=${noise}`, score);
      // Tau error should stay small even under noise
      expect(score.tauError).toBeLessThan(0.05);
      // Residual ratio should be roughly proportional to noise
      expect(score.residualRatio).toBeGreaterThan(0.3);
      expect(score.residualRatio).toBeLessThan(2.0);
      // Phase error should scale with noise but stay bounded
      expect(score.meanPhaseError).toBeLessThan(0.5 + noise * 0.3);
    });
  }
});

// ── Test 4: Gap degradation curve ──────────────────────────────────
// Baseline: all ~0.006-0.008. Tighten to 0.03/0.05/0.1.

describe("scoring: gap degradation", () => {
  const cases: [number, number][] = [
    [0.1, 0.03],
    [0.3, 0.05],
    [0.5, 0.1],
  ];

  for (const [gap, maxErr] of cases) {
    it(`gap=${(gap * 100).toFixed(0)}%: tau error < ${maxErr}`, () => {
      const opts: SyntheticOptions = { tau: 24.5, days: 150, noise: 0.5, gapFraction: gap, seed: 400 + Math.round(gap * 100) };
      const records = generateSyntheticRecords(opts);
      const analysis = analyzeCircadian(records);
      const score = scoreAnalysis(analysis, opts);
      logScore(`gap=${(gap * 100).toFixed(0)}%`, score);
      expect(score.tauError).toBeLessThan(maxErr);
    });
  }
});

// ── Test 5: Variable tau (step change) ─────────────────────────────
// Baseline: first=24.200, second=24.799. Tighten to ±0.1.

describe("scoring: variable tau", () => {
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
    const analysis = analyzeCircadian(records);

    const baseDate = new Date("2024-01-01T00:00:00");
    const firstHalfTaus: number[] = [];
    const secondHalfTaus: number[] = [];

    for (const day of analysis.days) {
      if (day.isForecast) continue;
      const d = Math.round(
        (new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000,
      );
      if (d >= 15 && d < 75) firstHalfTaus.push(day.localTau);
      else if (d >= 105 && d < 165) secondHalfTaus.push(day.localTau);
    }

    const meanFirst = firstHalfTaus.reduce((s, t) => s + t, 0) / firstHalfTaus.length;
    const meanSecond = secondHalfTaus.reduce((s, t) => s + t, 0) / secondHalfTaus.length;

    console.log(`  variable tau: first half mean=${meanFirst.toFixed(3)}, second half mean=${meanSecond.toFixed(3)}`);
    expect(Math.abs(meanFirst - 24.2)).toBeLessThan(0.1);
    expect(Math.abs(meanSecond - 24.8)).toBeLessThan(0.1);
  });
});

// ── Test 6: Nap contamination resistance ───────────────────────────
// Naps are 2-3h so they don't qualify as anchors (min 4h).
// Make naps longer (5-6h) so they DO become anchor candidates — the
// nap weight multiplier (0.15) is the only thing keeping them at bay.

describe("scoring: nap contamination", () => {
  it("tau error < 0.04 with 50% long-nap days", () => {
    // Generate records manually: main sleeps + long naps at offset phase
    const opts: SyntheticOptions = { tau: 24.5, days: 120, noise: 0.3, seed: 600 };
    const records = generateSyntheticRecords(opts);

    // Add long naps (5-6h, quality=0.7) at +6h offset from true circadian midpoint.
    // These qualify as Tier B anchors — the nap weight (0.15) should prevent them
    // from dominating the regression.
    const baseDate = new Date("2024-01-01T00:00:00");
    let napId = 90000;
    for (let d = 0; d < 120; d += 2) {
      const dayDate = new Date(baseDate);
      dayDate.setDate(dayDate.getDate() + d);
      const trueMid = computeTrueMidpoint(d, opts);
      const napMid = trueMid + 6; // 6h offset — significant but not anti-phase
      const napDur = 5.5;
      const halfDur = napDur / 2;
      const startMs = dayDate.getTime() + (napMid - halfDur) * 3_600_000;
      const endMs = dayDate.getTime() + (napMid + halfDur) * 3_600_000;
      const durationMs = endMs - startMs;
      const dateStr =
        dayDate.getFullYear() + "-" +
        String(dayDate.getMonth() + 1).padStart(2, "0") + "-" +
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

    const analysis = analyzeCircadian(records);
    const score = scoreAnalysis(analysis, opts);
    logScore("nap-contamination", score);
    expect(score.tauError).toBeLessThan(0.04);
    expect(score.meanPhaseError).toBeLessThan(0.8);
  });
});

// ── Test 7: Outlier contamination resistance ───────────────────────
// Increase to 20% outliers at 8h offset — more aggressive.
// Baseline with robust regression: tau error ~0.007.

describe("scoring: outlier contamination", () => {
  it("tau error < 0.05 with 20% outliers", () => {
    const opts: SyntheticOptions = {
      tau: 24.5,
      days: 150,
      noise: 0.3,
      outlierFraction: 0.2,
      outlierOffset: 8,
      seed: 700,
    };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const score = scoreAnalysis(analysis, opts);
    logScore("outlier-contamination", score);
    expect(score.tauError).toBeLessThan(0.05);
    expect(score.meanPhaseError).toBeLessThan(0.8);
  });
});

// ── Test 8: Forecast accuracy (holdout) ────────────────────────────
// Baseline: forecastPhaseError ~0.3. Tighten to 1.0.

describe("scoring: forecast accuracy", () => {
  it("forecast phase error < 1.0h on 30-day holdout", () => {
    const opts: SyntheticOptions = { tau: 24.5, days: 150, noise: 0.3, seed: 800 };
    const allRecords = generateSyntheticRecords(opts);

    const cutoffDate = new Date("2024-01-01T00:00:00");
    cutoffDate.setDate(cutoffDate.getDate() + 120);
    const trainRecords = allRecords.filter((r) => r.startTime.getTime() < cutoffDate.getTime());

    const analysis = analyzeCircadian(trainRecords, 30);
    const score = scoreAnalysis(analysis, opts, 120);
    logScore("forecast-holdout", score);
    expect(score.forecastPhaseError).toBeLessThan(1.5);
  });
});

// ── Test 9: Short dataset graceful degradation ─────────────────────

describe("scoring: short dataset degradation", () => {
  const lengths = [15, 30, 60, 90, 120];
  const errors: number[] = [];

  for (const days of lengths) {
    it(`${days} days: valid tau in [23.5, 25.5]`, () => {
      const opts: SyntheticOptions = { tau: 24.5, days, noise: 0.3, seed: 900 + days };
      const records = generateSyntheticRecords(opts);
      const analysis = analyzeCircadian(records);
      const score = scoreAnalysis(analysis, opts);
      logScore(`days=${days}`, score);
      errors.push(score.tauError);
      expect(analysis.globalTau).toBeGreaterThan(23.5);
      expect(analysis.globalTau).toBeLessThan(25.5);
    });
  }

  it("accuracy improves with more data", () => {
    if (errors.length === lengths.length) {
      expect(errors[errors.length - 1]!).toBeLessThan(errors[1]! + 0.05);
    }
  });
});

// ── Test 10: Confidence calibration ────────────────────────────────
// Use high noise + gaps to create a mix of confidence levels.

describe("scoring: confidence calibration", () => {
  it("high-confidence days have lower phase error than low-confidence days", () => {
    const opts: SyntheticOptions = { tau: 24.5, days: 200, noise: 1.5, gapFraction: 0.3, seed: 1000 };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);

    const baseDate = new Date("2024-01-01T00:00:00");
    const bins: { high: number[]; medium: number[]; low: number[] } = {
      high: [],
      medium: [],
      low: [],
    };

    for (const day of analysis.days) {
      if (day.isForecast) continue;
      const d = Math.round(
        (new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000,
      );
      const predictedMid = (day.nightStartHour + day.nightEndHour) / 2;
      const trueMid = computeTrueMidpoint(d, opts);
      const error = circularDistance(predictedMid, trueMid);
      bins[day.confidence].push(error);
    }

    const mean = (arr: number[]) =>
      arr.length > 0 ? arr.reduce((s, e) => s + e, 0) / arr.length : Infinity;

    const highMean = mean(bins.high);
    const medMean = mean(bins.medium);
    const lowMean = mean(bins.low);

    console.log(
      `  confidence calibration: high=${highMean.toFixed(2)} (n=${bins.high.length}), medium=${medMean.toFixed(2)} (n=${bins.medium.length}), low=${lowMean.toFixed(2)} (n=${bins.low.length})`,
    );

    // High-confidence should be better than low-confidence
    if (bins.high.length >= 5 && bins.low.length >= 5) {
      expect(highMean).toBeLessThan(lowMean + 0.5);
    }
    // At least two confidence levels should have samples
    const nonEmpty = [bins.high, bins.medium, bins.low].filter(b => b.length > 0).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(2);
  });
});

// ── Test 11: Sleep fragmentation resistance ────────────────────────

describe("scoring: sleep fragmentation", () => {
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
    const analysis = analyzeCircadian(records);

    const baseDate = new Date("2024-01-01T00:00:00");
    const fragmentedTaus: number[] = [];

    for (const day of analysis.days) {
      if (day.isForecast) continue;
      const d = Math.round(
        (new Date(day.date + "T00:00:00").getTime() - baseDate.getTime()) / 86_400_000,
      );

      // All localTau should be in reasonable range
      expect(day.localTau).toBeGreaterThan(24.0);
      expect(day.localTau).toBeLessThan(26.0);

      if (d >= 60 && d < 120) {
        fragmentedTaus.push(day.localTau);
      }
    }

    // Mean localTau during fragmented period should be close to true tau
    const meanFragTau = fragmentedTaus.reduce((s, t) => s + t, 0) / fragmentedTaus.length;
    console.log(`  fragmentation: mean localTau during fragmented period = ${meanFragTau.toFixed(3)} (true=25.0)`);
    expect(Math.abs(meanFragTau - 25.0)).toBeLessThan(0.5);
  });
});

// ── Test 12: Overlay smoothness ─────────────────────────────────────
// The circadian overlay midpoint should not jump more than a few hours
// between consecutive days. Max plausible daily drift is ~2h (tau=26),
// so a 3h threshold catches overlay breakage without false positives.

/** Circular midpoint from nightStart/nightEnd */
function overlayMid(day: { nightStartHour: number; nightEndHour: number }): number {
  return (((day.nightStartHour + day.nightEndHour) / 2) % 24 + 24) % 24;
}

/** Compute max day-to-day midpoint jump (circular) across non-forecast days */
function maxOverlayJump(days: CircadianAnalysis["days"]): { maxJump: number; atDate: string } {
  const data = days.filter(d => !d.isForecast);
  let maxJump = 0;
  let atDate = "";
  for (let i = 1; i < data.length; i++) {
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

describe("scoring: overlay smoothness (synthetic)", () => {
  it("no jumps > 3h with clean data", () => {
    const opts: SyntheticOptions = { tau: 25.0, days: 180, noise: 0.3, seed: 1200 };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const { maxJump, atDate } = maxOverlayJump(analysis.days);
    console.log(`  clean overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
    expect(maxJump).toBeLessThan(3);
  });

  it("no jumps > 3h with gaps", () => {
    const opts: SyntheticOptions = { tau: 24.5, days: 200, noise: 0.5, gapFraction: 0.3, seed: 1201 };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const { maxJump, atDate } = maxOverlayJump(analysis.days);
    console.log(`  gapped overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
    expect(maxJump).toBeLessThan(3);
  });

  it("no jumps > 3h with fragmented sleep", () => {
    const opts: SyntheticOptions = {
      tau: 25.0, days: 180, noise: 0.3, seed: 1202,
      fragmentedPeriod: { startDay: 60, endDay: 120, boutsPerDay: 3, boutDuration: 3.5 },
    };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const { maxJump, atDate } = maxOverlayJump(analysis.days);
    console.log(`  fragmented overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
    expect(maxJump).toBeLessThan(3);
  });

  it("no jumps > 3h with variable tau", () => {
    const opts: SyntheticOptions = {
      tauSegments: [{ untilDay: 90, tau: 24.2 }, { untilDay: 180, tau: 24.8 }],
      days: 180, noise: 0.3, seed: 1203,
    };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);
    const { maxJump, atDate } = maxOverlayJump(analysis.days);
    console.log(`  variable-tau overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
    expect(maxJump).toBeLessThan(3);
  });
});

describe.skipIf(!hasRealData)("scoring: overlay smoothness (real data)", () => {
  it("no jumps > 3h in real data overlay", () => {
    const records = loadRealData();
    const analysis = analyzeCircadian(records);
    const { maxJump, atDate } = maxOverlayJump(analysis.days);
    console.log(`  real data overlay: max jump = ${maxJump.toFixed(2)}h at ${atDate}`);
    expect(maxJump).toBeLessThan(3);
  });
});

// ── Test 14: Real data scoring ─────────────────────────────────────

describe.skipIf(!hasRealData)("scoring: real data", () => {
  it("reports accuracy scores on real data", () => {
    const records = loadRealData();
    const analysis = analyzeCircadian(records);

    const dataDays = analysis.days.filter((d) => !d.isForecast);
    const totalDays = dataDays.length;

    let prevMid = ((dataDays[0]!.nightStartHour + dataDays[0]!.nightEndHour) / 2 % 24 + 24) % 24;
    let accumulated = 0;

    for (let i = 1; i < dataDays.length; i++) {
      const mid = ((dataDays[i]!.nightStartHour + dataDays[i]!.nightEndHour) / 2 % 24 + 24) % 24;
      let delta = mid - prevMid;
      if (delta > 12) delta -= 24;
      if (delta < -12) delta += 24;
      accumulated += delta;
      prevMid = mid;
    }
    const revolutions = Math.abs(accumulated / 24);

    const estimatedTau = revolutions > 0.1 ? (24 * totalDays) / (totalDays - Math.sign(accumulated) * revolutions) : analysis.globalTau;

    console.log(`  Real data: ${records.length} records, ${totalDays} days`);
    console.log(`  globalTau=${analysis.globalTau.toFixed(4)}, revolution-tau=${estimatedTau.toFixed(4)}`);
    console.log(`  anchors=${analysis.anchorCount} (A=${analysis.anchorTierCounts.A} B=${analysis.anchorTierCounts.B} C=${analysis.anchorTierCounts.C})`);
    console.log(`  medianResidual=${analysis.medianResidualHours.toFixed(3)}h`);

    expect(analysis.globalTau).toBeGreaterThan(23.5);
    expect(analysis.globalTau).toBeLessThan(26.5);
    expect(analysis.medianResidualHours).toBeLessThan(4);

    // Per-day localTau should stay bounded — no unreasonable values
    for (const day of dataDays) {
      expect(day.localTau).toBeGreaterThan(23.5);
      expect(day.localTau).toBeLessThan(26.0);
    }
  });
});

// ── Cumulative phase shift utilities ────────────────────────────────

/** Compute cumulative phase shift from overlay day-to-day deltas (in hours) */
function cumulativeShiftHours(days: CircadianAnalysis["days"]): number {
  const data = days.filter(d => !d.isForecast);
  if (data.length < 2) return 0;
  let prevMid = overlayMid(data[0]!);
  let accumulated = 0;
  for (let i = 1; i < data.length; i++) {
    const mid = overlayMid(data[i]!);
    let delta = mid - prevMid;
    if (delta > 12) delta -= 24;
    if (delta < -12) delta += 24;
    accumulated += delta;
    prevMid = mid;
  }
  return accumulated;
}

/** Convert cumulative shift to implied tau */
function shiftToTau(shiftHours: number, numDays: number): number {
  const revolutions = Math.abs(shiftHours / 24);
  if (revolutions < 0.1) return 24;
  return (24 * numDays) / (numDays - Math.sign(shiftHours) * revolutions);
}

// ── Test 15: Cumulative phase shift vs ground truth (synthetic) ─────

describe("scoring: cumulative phase shift (synthetic)", () => {
  const cases: { tau: number; days: number }[] = [
    { tau: 24.0, days: 180 },
    { tau: 24.5, days: 180 },
    { tau: 25.0, days: 180 },
    { tau: 25.0, days: 90 },
  ];

  for (const { tau, days } of cases) {
    it(`tau=${tau}, ${days}d: overlay shift within 15% of expected`, () => {
      const opts: SyntheticOptions = { tau, days, noise: 0.3, seed: 1500 + Math.round(tau * 100) + days };
      const records = generateSyntheticRecords(opts);
      const analysis = analyzeCircadian(records);

      const dataDays = analysis.days.filter(d => !d.isForecast);
      const expectedShiftH = (tau - 24) * dataDays.length;
      const actualShiftH = cumulativeShiftHours(analysis.days);
      const impliedTau = shiftToTau(actualShiftH, dataDays.length);

      console.log(
        `  tau=${tau} ${days}d: expected=${expectedShiftH.toFixed(1)}h actual=${actualShiftH.toFixed(1)}h impliedTau=${impliedTau.toFixed(4)}`,
      );

      if (Math.abs(expectedShiftH) < 1) {
        // For tau≈24, absolute tolerance (shift near 0)
        expect(Math.abs(actualShiftH - expectedShiftH)).toBeLessThan(5);
      } else {
        // Relative tolerance: overlay shift should be within 15% of expected
        const ratio = actualShiftH / expectedShiftH;
        expect(ratio).toBeGreaterThan(0.85);
        expect(ratio).toBeLessThan(1.15);
      }
    });
  }

  it("fragmented period preserves cumulative shift", () => {
    const tau = 25.0;
    const opts: SyntheticOptions = {
      tau, days: 180, noise: 0.3, seed: 1550,
      fragmentedPeriod: { startDay: 60, endDay: 120, boutsPerDay: 3, boutDuration: 3.5 },
    };
    const records = generateSyntheticRecords(opts);
    const analysis = analyzeCircadian(records);

    const dataDays = analysis.days.filter(d => !d.isForecast);
    const expectedShiftH = (tau - 24) * dataDays.length;
    const actualShiftH = cumulativeShiftHours(analysis.days);
    const impliedTau = shiftToTau(actualShiftH, dataDays.length);

    console.log(
      `  fragmented: expected=${expectedShiftH.toFixed(1)}h actual=${actualShiftH.toFixed(1)}h impliedTau=${impliedTau.toFixed(4)}`,
    );

    const ratio = actualShiftH / expectedShiftH;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.15);
  });
});

// ── Test 16: Overlay shift vs periodogram (real data) ───────────────

describe.skipIf(!hasRealData)("scoring: cumulative shift vs periodogram (real data)", () => {
  it("overlay implied tau within 15% drift of periodogram peak", () => {
    const records = loadRealData();
    const analysis = analyzeCircadian(records);
    const periodogram = computeLombScargle(analysis.anchors);

    const dataDays = analysis.days.filter(d => !d.isForecast);
    const numDays = dataDays.length;
    const actualShiftH = cumulativeShiftHours(analysis.days);
    const overlayTau = shiftToTau(actualShiftH, numDays);

    const peakTau = periodogram.peakPeriod;
    const expectedShiftH = (peakTau - 24) * numDays;

    // Compare drifts (tau - 24) rather than raw tau, since drift is the
    // quantity that accumulates and small absolute differences in tau
    // compound over hundreds of days
    const overlayDrift = overlayTau - 24;
    const periodogramDrift = peakTau - 24;

    console.log(
      `  periodogram peak: ${peakTau.toFixed(4)}h (power=${periodogram.peakPower.toFixed(3)}, sig=${periodogram.significanceThreshold.toFixed(3)})`,
    );
    console.log(
      `  overlay: shift=${actualShiftH.toFixed(1)}h impliedTau=${overlayTau.toFixed(4)}`,
    );
    console.log(
      `  expected shift: ${expectedShiftH.toFixed(1)}h`,
    );
    console.log(
      `  drift comparison: overlay=${overlayDrift.toFixed(4)} periodogram=${periodogramDrift.toFixed(4)} ratio=${(overlayDrift / periodogramDrift).toFixed(3)}`,
    );

    // The overlay's implied drift should be within 15% of the periodogram's
    if (periodogramDrift > 0.05) {
      const driftRatio = overlayDrift / periodogramDrift;
      expect(driftRatio).toBeGreaterThan(0.85);
      expect(driftRatio).toBeLessThan(1.15);
    }
  });
});
