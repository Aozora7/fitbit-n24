import type { SleepRecord } from "../../../api/types";

/** Simple seeded PRNG (mulberry32) for reproducible test data */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller Gaussian sample from a seeded RNG */
function gaussianSample(rng: () => number): number {
  const u1 = rng();
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
}

export interface TauSegment {
  untilDay: number;
  tau: number;
}

export interface SyntheticOptions {
  /** Circadian period in hours (default 24.5) */
  tau?: number;
  /** Number of days to generate (default 90) */
  days?: number;
  /** Base sleep duration in hours (default 8) */
  baseDuration?: number;
  /** Gaussian noise stddev on midpoint in hours (default 0.5) */
  noise?: number;
  /** Fraction of days to randomly skip (0-1, default 0) */
  gapFraction?: number;
  /** Starting midpoint hour (0-24, default 3 = 3 AM) */
  startMidpoint?: number;
  /** PRNG seed (default 42) */
  seed?: number;
  /** Sleep quality score (default 0.8) */
  quality?: number;
  /** Piecewise tau segments — overrides tau when provided */
  tauSegments?: TauSegment[];
  /** Fraction of days that also get a nap record (0-1, default 0) */
  napFraction?: number;
  /** Fraction of main sleeps shifted off-phase (0-1, default 0) */
  outlierFraction?: number;
  /** Hours off-phase for outlier sleeps (default 6) */
  outlierOffset?: number;
}

/**
 * Compute the true midpoint hour (unwrapped, relative to day 0 midnight)
 * for a given day, accounting for tauSegments or constant tau.
 */
export function computeTrueMidpoint(day: number, opts: SyntheticOptions = {}): number {
  const { startMidpoint = 3, tau = 24.5, tauSegments } = opts;

  if (!tauSegments || tauSegments.length === 0) {
    return startMidpoint + day * (tau - 24);
  }

  // Integrate piecewise drift
  let midpoint = startMidpoint;
  let prevDay = 0;
  for (const seg of tauSegments) {
    const segEnd = Math.min(day, seg.untilDay);
    if (prevDay >= segEnd) { prevDay = seg.untilDay; continue; }
    midpoint += (segEnd - prevDay) * (seg.tau - 24);
    prevDay = segEnd;
    if (prevDay >= day) break;
  }
  return midpoint;
}

/** Get drift (tau - 24) for a given day from tauSegments or constant tau */
function getDrift(day: number, opts: SyntheticOptions): number {
  const { tau = 24.5, tauSegments } = opts;
  if (!tauSegments || tauSegments.length === 0) return tau - 24;
  for (const seg of tauSegments) {
    if (day < seg.untilDay) return seg.tau - 24;
  }
  return tauSegments[tauSegments.length - 1]!.tau - 24;
}

/**
 * Generate synthetic SleepRecord[] with a known tau for testing.
 * Supports variable tau (tauSegments), naps, and outliers.
 */
export function generateSyntheticRecords(opts: SyntheticOptions = {}): SleepRecord[] {
  const {
    days = 90,
    baseDuration = 8,
    noise = 0.5,
    gapFraction = 0,
    seed = 42,
    quality = 0.8,
    napFraction = 0,
    outlierFraction = 0,
    outlierOffset = 6,
  } = opts;

  const rng = mulberry32(seed);
  const records: SleepRecord[] = [];
  const baseDate = new Date("2024-01-01T00:00:00");
  let nextLogId = 1000;

  for (let d = 0; d < days; d++) {
    // Skip this day randomly
    if (gapFraction > 0 && rng() < gapFraction) {
      // Consume RNG slots to keep determinism regardless of gap outcomes
      rng(); rng(); rng();
      continue;
    }

    const midpointTrue = computeTrueMidpoint(d, opts);
    const midpointHour = midpointTrue + gaussianSample(rng) * noise;

    // Outlier shift
    const isOutlier = outlierFraction > 0 && rng() < outlierFraction;
    const finalMidpoint = isOutlier ? midpointHour + outlierOffset : midpointHour;

    const durationHours = baseDuration + (rng() - 0.5) * 1; // ±0.5h variation
    const halfDur = durationHours / 2;

    const dayDate = new Date(baseDate);
    dayDate.setDate(dayDate.getDate() + d);

    const startMs = dayDate.getTime() + (finalMidpoint - halfDur) * 3_600_000;
    const endMs = dayDate.getTime() + (finalMidpoint + halfDur) * 3_600_000;
    const durationMs = endMs - startMs;

    const dateStr =
      dayDate.getFullYear() +
      "-" +
      String(dayDate.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(dayDate.getDate()).padStart(2, "0");

    records.push({
      logId: nextLogId++,
      dateOfSleep: dateStr,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      durationMs,
      durationHours: durationMs / 3_600_000,
      efficiency: 90,
      minutesAsleep: Math.round((durationMs / 60_000) * 0.9),
      minutesAwake: Math.round((durationMs / 60_000) * 0.1),
      isMainSleep: true,
      sleepScore: quality,
    });

    // Generate nap for this day
    if (napFraction > 0 && rng() < napFraction) {
      const napDuration = 2 + rng(); // 2-3 hours
      const napMidpoint = midpointTrue + 12 + gaussianSample(rng) * 2; // ~12h offset, noisy
      const napHalfDur = napDuration / 2;
      const napStartMs = dayDate.getTime() + (napMidpoint - napHalfDur) * 3_600_000;
      const napEndMs = dayDate.getTime() + (napMidpoint + napHalfDur) * 3_600_000;
      const napDurMs = napEndMs - napStartMs;

      records.push({
        logId: nextLogId++,
        dateOfSleep: dateStr,
        startTime: new Date(napStartMs),
        endTime: new Date(napEndMs),
        durationMs: napDurMs,
        durationHours: napDurMs / 3_600_000,
        efficiency: 80,
        minutesAsleep: Math.round((napDurMs / 60_000) * 0.85),
        minutesAwake: Math.round((napDurMs / 60_000) * 0.15),
        isMainSleep: false,
        sleepScore: 0.5,
      });
    }
  }

  // Sort by start time
  records.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  return records;
}
