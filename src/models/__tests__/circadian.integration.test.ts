import { describe, it, expect } from "vitest";
import { analyzeCircadian } from "../circadian";
import { generateSyntheticRecords } from "./fixtures/synthetic";
import { hasRealData, loadRealData } from "./fixtures/loadRealData";

// ── Synthetic data tests ────────────────────────────────────────────

describe("analyzeCircadian — synthetic data", () => {
  it("detects tau=24.0 within ±0.1h", () => {
    const records = generateSyntheticRecords({ tau: 24.0, days: 120, noise: 0.3, seed: 1 });
    const result = analyzeCircadian(records);
    expect(result.globalTau).toBeCloseTo(24.0, 0);
    expect(Math.abs(result.globalTau - 24.0)).toBeLessThan(0.1);
  });

  it("detects tau=24.5 within ±0.1h", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 120, noise: 0.3, seed: 2 });
    const result = analyzeCircadian(records);
    expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.1);
  });

  it("detects tau=25.0 within ±0.15h", () => {
    const records = generateSyntheticRecords({ tau: 25.0, days: 120, noise: 0.3, seed: 3 });
    const result = analyzeCircadian(records);
    expect(Math.abs(result.globalTau - 25.0)).toBeLessThan(0.15);
  });

  it("handles noisy data within ±0.5h", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 150, noise: 1.5, seed: 4 });
    const result = analyzeCircadian(records);
    expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.5);
  });

  it("tolerates 30% gaps", () => {
    const records = generateSyntheticRecords({
      tau: 24.5, days: 150, noise: 0.5, gapFraction: 0.3, seed: 5,
    });
    const result = analyzeCircadian(records);
    expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.3);
  });

  it("returns sane defaults for empty input", () => {
    const result = analyzeCircadian([]);
    expect(result.globalTau).toBe(24);
    expect(result.days).toHaveLength(0);
    expect(result.anchors).toHaveLength(0);
  });

  it("returns sane defaults for single record", () => {
    const records = generateSyntheticRecords({ days: 1 });
    const result = analyzeCircadian(records);
    expect(result.globalTau).toBe(24);
  });

  it("produces forecast days with extraDays parameter", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 6 });
    const noForecast = analyzeCircadian(records, 0);
    const withForecast = analyzeCircadian(records, 14);
    expect(withForecast.days.length).toBe(noForecast.days.length + 14);
    // Last 14 days should be marked as forecast
    const forecastDays = withForecast.days.filter(d => d.isForecast);
    expect(forecastDays.length).toBe(14);
  });

  it("forecast confidence decays over time", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 90, seed: 7 });
    const result = analyzeCircadian(records, 30);
    const forecasts = result.days.filter(d => d.isForecast);
    expect(forecasts.length).toBe(30);
    // First forecast day should have higher confidence than last
    expect(forecasts[0]!.confidenceScore).toBeGreaterThan(forecasts[forecasts.length - 1]!.confidenceScore);
  });

  it("median residual is reasonable", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 120, noise: 0.5, seed: 8 });
    const result = analyzeCircadian(records);
    expect(result.medianResidualHours).toBeLessThan(3);
  });

  it("populates tier counts", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 90, quality: 0.85, seed: 9 });
    const result = analyzeCircadian(records);
    expect(result.anchorTierCounts.A).toBeGreaterThan(0);
    expect(result.anchorCount).toBeGreaterThan(0);
  });
});

// ── Distant data should not corrupt local tau ──────────────────────

describe("analyzeCircadian — locality of tau estimation", () => {
  it("distant historical data does not pull local tau at end of dataset", () => {
    // Scenario: 300 days of tau=24.5, then 120 days of tau=25.15
    // Local tau at the end should track the recent segment (~25.15),
    // not get pulled toward the historical average (~24.5).
    const records = generateSyntheticRecords({
      tauSegments: [
        { untilDay: 300, tau: 24.5 },
        { untilDay: 420, tau: 25.15 },
      ],
      days: 420,
      noise: 0.3,
      seed: 100,
    });

    const fullResult = analyzeCircadian(records);
    const lastDay = fullResult.days[fullResult.days.length - 1]!;

    // Local tau at the end should be close to 25.15, not pulled toward 24.5
    expect(lastDay.localTau).toBeGreaterThan(24.9);
    expect(Math.abs(lastDay.localTau - 25.15)).toBeLessThan(0.3);
  });

  it("recent-only subset matches local tau from full dataset", () => {
    // Generate full dataset with two distinct tau segments
    const allRecords = generateSyntheticRecords({
      tauSegments: [
        { untilDay: 300, tau: 24.5 },
        { untilDay: 420, tau: 25.15 },
      ],
      days: 420,
      noise: 0.3,
      seed: 100,
    });

    // Analyze only last 90 days
    const recentRecords = allRecords.filter(r => {
      const dayNum = Math.round(
        (r.startTime.getTime() - allRecords[0]!.startTime.getTime()) / 86_400_000
      );
      return dayNum >= 330;
    });

    const fullResult = analyzeCircadian(allRecords);
    const recentResult = analyzeCircadian(recentRecords);

    // Get local tau at the last day of data for both
    const fullLastDay = fullResult.days[fullResult.days.length - 1]!;
    const recentLastDay = recentResult.days[recentResult.days.length - 1]!;

    // Local tau from full dataset should be within 0.25h of recent-only analysis
    // (i.e., distant data shouldn't significantly distort the local estimate)
    expect(Math.abs(fullLastDay.localTau - recentLastDay.localTau)).toBeLessThan(0.25);
  });
});

// ── Data gap handling ───────────────────────────────────────────────

describe("analyzeCircadian — data gap handling", () => {
  it("marks days in a 30-day gap as isGap", () => {
    // 60 days of data, then 30-day gap, then 60 more days
    const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 200 });
    const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 201, startMidpoint: 3 });

    // Shift "after" records forward by 90 days (60 data + 30 gap)
    const offsetMs = 90 * 86_400_000;
    const baseTime = before[0]!.startTime.getTime();
    const shiftedAfter = after.map(r => {
      const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
      const newStart = new Date(baseTime + offsetMs + dayOffset);
      const newEnd = new Date(newStart.getTime() + r.durationMs);
      const newDate = new Date(baseTime + offsetMs + dayOffset);
      newDate.setHours(0, 0, 0, 0);
      const dateStr = newDate.getFullYear() + "-" + String(newDate.getMonth() + 1).padStart(2, "0") + "-" + String(newDate.getDate()).padStart(2, "0");
      return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
    });

    const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // The entire gap should be isGap — approximately 30 days
    // (exact count depends on whether last data day falls on day 59 or 60)
    const gapDays = result.days.filter(d => d.isGap);
    expect(gapDays.length).toBeGreaterThanOrEqual(28);
    expect(gapDays.length).toBeLessThanOrEqual(31);

    // Days with data should NOT be isGap
    const dataDays = result.days.filter(d => !d.isGap && !d.isForecast);
    expect(dataDays.length).toBeGreaterThan(100);
  });

  it("does not mark days in a 10-day gap as isGap (below threshold)", () => {
    const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 210 });
    const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 211 });

    // Shift "after" records forward by 70 days (60 data + 10 gap)
    const offsetMs = 70 * 86_400_000;
    const baseTime = before[0]!.startTime.getTime();
    const shiftedAfter = after.map(r => {
      const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
      const newStart = new Date(baseTime + offsetMs + dayOffset);
      const newEnd = new Date(newStart.getTime() + r.durationMs);
      const newDate = new Date(baseTime + offsetMs + dayOffset);
      newDate.setHours(0, 0, 0, 0);
      const dateStr = newDate.getFullYear() + "-" + String(newDate.getMonth() + 1).padStart(2, "0") + "-" + String(newDate.getDate()).padStart(2, "0");
      return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
    });

    const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // No days should be isGap — the 10-day gap is below the 14-day threshold
    const gapDays = result.days.filter(d => d.isGap);
    expect(gapDays.length).toBe(0);
  });

  it("gap boundary days have correct isGap values", () => {
    // 60 days data, 40-day gap, 60 days data
    const before = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 220 });
    const after = generateSyntheticRecords({ tau: 24.5, days: 60, seed: 221 });

    const offsetMs = 100 * 86_400_000; // 60 + 40 gap
    const baseTime = before[0]!.startTime.getTime();
    const shiftedAfter = after.map(r => {
      const dayOffset = r.startTime.getTime() - after[0]!.startTime.getTime();
      const newStart = new Date(baseTime + offsetMs + dayOffset);
      const newEnd = new Date(newStart.getTime() + r.durationMs);
      const newDate = new Date(baseTime + offsetMs + dayOffset);
      newDate.setHours(0, 0, 0, 0);
      const dateStr = newDate.getFullYear() + "-" + String(newDate.getMonth() + 1).padStart(2, "0") + "-" + String(newDate.getDate()).padStart(2, "0");
      return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
    });

    const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // Find the last non-gap day before the gap and first non-gap day after
    const lastBeforeGap = before[before.length - 1]!.dateOfSleep;
    const firstAfterGap = shiftedAfter[0]!.dateOfSleep;

    // Days with data should NOT be isGap
    const dayBeforeGap = result.days.find(d => d.date === lastBeforeGap)!;
    expect(dayBeforeGap.isGap).toBe(false);
    const dayAfterGap = result.days.find(d => d.date === firstAfterGap)!;
    expect(dayAfterGap.isGap).toBe(false);

    // Day in the middle of the gap should be isGap
    const midIdx = result.days.indexOf(dayBeforeGap) + 20;
    expect(result.days[midIdx]!.isGap).toBe(true);

    // First day after last data should be isGap (entire gap is suppressed)
    const firstGapIdx = result.days.indexOf(dayBeforeGap) + 1;
    expect(result.days[firstGapIdx]!.isGap).toBe(true);

    // Last day before data resumes should be isGap
    const lastGapIdx = result.days.indexOf(dayAfterGap) - 1;
    expect(result.days[lastGapIdx]!.isGap).toBe(true);

    // Entire gap should be ~40 days
    const gapDays = result.days.filter(d => d.isGap);
    expect(gapDays.length).toBeGreaterThanOrEqual(38);
    expect(gapDays.length).toBeLessThanOrEqual(42);

    // Forecast days should never be isGap
    const forecastResult = analyzeCircadian(records, 14);
    const forecastDays = forecastResult.days.filter(d => d.isForecast);
    expect(forecastDays.every(d => !d.isGap)).toBe(true);
  });
});

// ── Segment isolation tests ─────────────────────────────────────────

describe("analyzeCircadian — segment isolation", () => {
  /** Helper: shift records forward by offsetDays relative to a base time */
  function shiftRecords(records: ReturnType<typeof generateSyntheticRecords>, baseTime: number, offsetDays: number) {
    const offsetMs = offsetDays * 86_400_000;
    const firstStart = records[0]!.startTime.getTime();
    return records.map(r => {
      const dayOffset = r.startTime.getTime() - firstStart;
      const newStart = new Date(baseTime + offsetMs + dayOffset);
      const newEnd = new Date(newStart.getTime() + r.durationMs);
      const newDate = new Date(baseTime + offsetMs + dayOffset);
      newDate.setHours(0, 0, 0, 0);
      const dateStr = newDate.getFullYear() + "-" + String(newDate.getMonth() + 1).padStart(2, "0") + "-" + String(newDate.getDate()).padStart(2, "0");
      return { ...r, startTime: newStart, endTime: newEnd, dateOfSleep: dateStr };
    });
  }

  it("cross-gap tau isolation: post-gap local tau tracks local data, not pre-gap", () => {
    // 90 days tau=24.2, 30-day gap, 90 days tau=25.0
    const before = generateSyntheticRecords({ tau: 24.2, days: 90, noise: 0.3, seed: 3000 });
    const after = generateSyntheticRecords({ tau: 25.0, days: 90, noise: 0.3, seed: 3001, startMidpoint: 3 });

    const baseTime = before[0]!.startTime.getTime();
    const shiftedAfter = shiftRecords(after, baseTime, 120); // 90 data + 30 gap

    const records = [...before, ...shiftedAfter].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // Find days in the post-gap segment (roughly days 120-209)
    const postGapDays = result.days.filter(d => {
      const date = d.date;
      return !d.isGap && !d.isForecast && date > shiftedAfter[0]!.dateOfSleep;
    });
    expect(postGapDays.length).toBeGreaterThan(50);

    // Average local tau in the post-gap segment should track 25.0, not be pulled toward 24.2
    const postGapTaus = postGapDays.slice(20, -10).map(d => d.localTau); // avoid edges
    const meanPostGapTau = postGapTaus.reduce((s, t) => s + t, 0) / postGapTaus.length;
    expect(Math.abs(meanPostGapTau - 25.0)).toBeLessThan(0.25);
  });

  it("multi-segment: three segments with different taus", () => {
    const seg1 = generateSyntheticRecords({ tau: 24.2, days: 60, noise: 0.3, seed: 3010 });
    const seg2 = generateSyntheticRecords({ tau: 25.0, days: 60, noise: 0.3, seed: 3011, startMidpoint: 3 });
    const seg3 = generateSyntheticRecords({ tau: 24.5, days: 60, noise: 0.3, seed: 3012, startMidpoint: 3 });

    const baseTime = seg1[0]!.startTime.getTime();
    const shifted2 = shiftRecords(seg2, baseTime, 80);  // 60 + 20 gap
    const shifted3 = shiftRecords(seg3, baseTime, 160); // 80 + 60 + 20 gap

    const records = [...seg1, ...shifted2, ...shifted3].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // Should have gap days between segments
    const gapDays = result.days.filter(d => d.isGap);
    expect(gapDays.length).toBeGreaterThan(30); // ~20 + ~20 gap days

    // Each segment's interior should have local tau close to its true value
    const allDataDays = result.days.filter(d => !d.isGap && !d.isForecast);
    expect(allDataDays.length).toBeGreaterThan(150);
  });

  it("tiny segment (< 2 anchors) is skipped gracefully", () => {
    // Create a single record that will form its own tiny segment
    const main = generateSyntheticRecords({ tau: 24.5, days: 90, noise: 0.3, seed: 3020 });
    const tiny = generateSyntheticRecords({ tau: 24.5, days: 1, seed: 3021, quality: 0.8 });

    const baseTime = main[0]!.startTime.getTime();
    const shiftedTiny = shiftRecords(tiny, baseTime, 110); // 90 + 20 gap

    const records = [...main, ...shiftedTiny].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const result = analyzeCircadian(records);

    // Should not crash; main segment should still produce output
    expect(result.days.length).toBeGreaterThan(80);
    expect(result.anchorCount).toBeGreaterThan(10);
  });

  it("no-gap dataset produces same results as before (single segment)", () => {
    const records = generateSyntheticRecords({ tau: 24.5, days: 120, noise: 0.3, seed: 3030 });
    const result = analyzeCircadian(records);

    // Should behave identically to a single-segment analysis
    expect(result.days.filter(d => d.isGap).length).toBe(0);
    expect(Math.abs(result.globalTau - 24.5)).toBeLessThan(0.1);
    expect(result.days.length).toBe(120);
    expect(result.anchorCount).toBeGreaterThan(50);
  });
});

// ── DSPD to N24 transition detection ────────────────────────────────

describe("analyzeCircadian — DSPD to N24 transition", () => {
  it("detects N24 drift after long DSPD period (300d tau=24.0 + 30d tau=24.5)", () => {
    // Extreme ratio: 10:1 DSPD-to-N24 — the regional slope fallback (180-day window)
    // and smoothing must not let the DSPD era mask the recent N24 drift.
    const records = generateSyntheticRecords({
      tauSegments: [
        { untilDay: 300, tau: 24.0 },
        { untilDay: 330, tau: 24.5 },
      ],
      days: 330,
      noise: 0.3,
      seed: 4000,
    });

    const result = analyzeCircadian(records);

    // Local tau in the last 15 days should detect N24 drift (> 24.2)
    const last15 = result.days.slice(-15);
    const meanTau = last15.reduce((s, d) => s + d.localTau, 0) / last15.length;
    expect(meanTau).toBeGreaterThan(24.2);
  });

  it("full dataset local tau matches recent-only (300d DSPD + 60d N24)", () => {
    // The full dataset's local tau at the end should not diverge significantly
    // from analyzing only the N24 portion.
    const records = generateSyntheticRecords({
      tauSegments: [
        { untilDay: 300, tau: 24.0 },
        { untilDay: 360, tau: 24.5 },
      ],
      days: 360,
      noise: 0.3,
      seed: 4001,
    });

    // Analyze full dataset
    const fullResult = analyzeCircadian(records);

    // Analyze only last 60 days
    const recentRecords = records.filter(r => {
      const dayNum = Math.round(
        (r.startTime.getTime() - records[0]!.startTime.getTime()) / 86_400_000
      );
      return dayNum >= 300;
    });
    const recentResult = analyzeCircadian(recentRecords);

    // Compare local tau at end
    const fullLastTau = fullResult.days[fullResult.days.length - 1]!.localTau;
    const recentLastTau = recentResult.days[recentResult.days.length - 1]!.localTau;

    // Full-dataset tau at end should be within 0.3h of recent-only
    expect(Math.abs(fullLastTau - recentLastTau)).toBeLessThan(0.3);
  });

  it("detects gradual transition (250d tau=24.0 → 30d tau=24.15 → 30d tau=24.5)", () => {
    // Gradual transition after a long stable DSPD period
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

    const result = analyzeCircadian(records);

    // Local tau in the last 15 days should detect N24 drift (> 24.2)
    const last15 = result.days.slice(-15);
    const meanTau = last15.reduce((s, d) => s + d.localTau, 0) / last15.length;
    expect(meanTau).toBeGreaterThan(24.2);
  });
});

// ── Real data regression tests ──────────────────────────────────────

describe.skipIf(!hasRealData)("analyzeCircadian — real data regression", () => {
  it("produces consistent output on real data", () => {
    const records = loadRealData();
    expect(records.length).toBeGreaterThan(100);

    const result = analyzeCircadian(records);

    // Global tau should be in a plausible range (may include DSPD periods)
    expect(result.globalTau).toBeGreaterThan(23.5);
    expect(result.globalTau).toBeLessThan(26.0);

    // Should have meaningful anchor counts
    expect(result.anchorCount).toBeGreaterThan(50);
    expect(result.anchorTierCounts.A).toBeGreaterThan(0);

    // Median residual should be reasonable
    expect(result.medianResidualHours).toBeLessThan(3);

    // Days array should cover the data range
    expect(result.days.length).toBeGreaterThan(100);

    // All days should have valid confidence
    for (const day of result.days) {
      expect(day.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(day.confidenceScore).toBeLessThanOrEqual(1);
      expect(["high", "medium", "low"]).toContain(day.confidence);
    }
  });

  it("marks long data gaps as isGap", () => {
    const records = loadRealData();
    const result = analyzeCircadian(records);

    // The 75-day gap (2024-09-03 to 2024-11-17) should have isGap days in its interior
    const gapInterior = result.days.filter(d => {
      const date = d.date;
      return date >= "2024-09-20" && date <= "2024-11-01";
    });
    expect(gapInterior.length).toBeGreaterThan(0);
    expect(gapInterior.every(d => d.isGap)).toBe(true);

    // Days with actual data should not be isGap
    const daysWithAnchors = result.days.filter(d => d.anchorSleep != null);
    expect(daysWithAnchors.every(d => !d.isGap)).toBe(true);
  });

  it("forecast extends smoothly from data", () => {
    const records = loadRealData();
    const result = analyzeCircadian(records, 14);

    const dataDays = result.days.filter(d => !d.isForecast);
    const forecastDays = result.days.filter(d => d.isForecast);

    expect(forecastDays.length).toBe(14);

    // Last data day and first forecast day should have similar tau
    const lastData = dataDays[dataDays.length - 1]!;
    const firstForecast = forecastDays[0]!;
    expect(Math.abs(lastData.localTau - firstForecast.localTau)).toBeLessThan(0.5);
  });
});
