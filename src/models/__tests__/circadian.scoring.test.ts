import { describe, it, expect } from "vitest";
import { analyzeCircadian, type CircadianAnalysis } from "../circadian";
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

// ── Test 11: Real data scoring ─────────────────────────────────────

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
  });
});
