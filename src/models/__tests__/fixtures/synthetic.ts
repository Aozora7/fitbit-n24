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
}

/**
 * Generate synthetic SleepRecord[] with a known tau for testing.
 * All records are isMainSleep=true with stages-type data.
 */
export function generateSyntheticRecords(opts: SyntheticOptions = {}): SleepRecord[] {
  const {
    tau = 24.5,
    days = 90,
    baseDuration = 8,
    noise = 0.5,
    gapFraction = 0,
    startMidpoint = 3,
    seed = 42,
    quality = 0.8,
  } = opts;

  const rng = mulberry32(seed);
  const records: SleepRecord[] = [];
  const baseDate = new Date("2024-01-01T00:00:00");
  const drift = tau - 24; // hours per day

  for (let d = 0; d < days; d++) {
    // Skip this day randomly
    if (gapFraction > 0 && rng() < gapFraction) continue;

    // Box-Muller for Gaussian noise
    const u1 = rng();
    const u2 = rng();
    const gaussianNoise = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);

    const midpointHour = startMidpoint + d * drift + gaussianNoise * noise;
    const durationHours = baseDuration + (rng() - 0.5) * 1; // ±0.5h variation
    const halfDur = durationHours / 2;

    const dayDate = new Date(baseDate);
    dayDate.setDate(dayDate.getDate() + d);

    const startMs = dayDate.getTime() + (midpointHour - halfDur) * 3_600_000;
    const endMs = dayDate.getTime() + (midpointHour + halfDur) * 3_600_000;
    const durationMs = endMs - startMs;

    const dateStr =
      dayDate.getFullYear() +
      "-" +
      String(dayDate.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(dayDate.getDate()).padStart(2, "0");

    records.push({
      logId: 1000 + d,
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
  }

  // Sort by start time
  records.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
  return records;
}
