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

// ── Real data regression tests ──────────────────────────────────────

describe.skipIf(!hasRealData)("analyzeCircadian — real data regression", () => {
  it("produces consistent output on real data", () => {
    const records = loadRealData();
    expect(records.length).toBeGreaterThan(100);

    const result = analyzeCircadian(records);

    // Global tau should be in N24 range
    expect(result.globalTau).toBeGreaterThan(24.1);
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
