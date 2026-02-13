import { describe, it, expect } from "vitest";
import { _internals } from "../circadian";
import type { SleepRecord } from "../../api/types";

const {
  classifyAnchor,
  sleepMidpointHour,
  localPairwiseUnwrap,
  weightedLinearRegression,
  robustWeightedRegression,
  gaussian,
  computeMedianSpacing,
} = _internals;

// ── Helper: minimal SleepRecord for classifyAnchor ──────────────────

function makeSleepRecord(overrides: Partial<SleepRecord> = {}): SleepRecord {
  const base = new Date("2024-03-15T23:00:00");
  return {
    logId: 1,
    dateOfSleep: "2024-03-15",
    startTime: base,
    endTime: new Date(base.getTime() + 8 * 3_600_000),
    durationMs: 8 * 3_600_000,
    durationHours: 8,
    efficiency: 90,
    minutesAsleep: 420,
    minutesAwake: 30,
    isMainSleep: true,
    sleepScore: 0.85,
    ...overrides,
  };
}

// ── classifyAnchor ──────────────────────────────────────────────────

describe("classifyAnchor", () => {
  it("classifies tier A (≥7h, ≥0.75 quality)", () => {
    const result = classifyAnchor(makeSleepRecord({ durationHours: 7, sleepScore: 0.75 }));
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("A");
    expect(result!.weight).toBeGreaterThan(0);
  });

  it("classifies tier B (≥5h, ≥0.6 quality)", () => {
    const result = classifyAnchor(makeSleepRecord({ durationHours: 5.5, sleepScore: 0.65 }));
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("B");
  });

  it("classifies tier C (≥4h, ≥0.4 quality)", () => {
    const result = classifyAnchor(makeSleepRecord({ durationHours: 4.5, sleepScore: 0.45 }));
    expect(result).not.toBeNull();
    expect(result!.tier).toBe("C");
  });

  it("returns null for low quality short sleep", () => {
    const result = classifyAnchor(makeSleepRecord({ durationHours: 3, sleepScore: 0.3 }));
    expect(result).toBeNull();
  });

  it("returns null for boundary miss (4h, 0.39 quality)", () => {
    const result = classifyAnchor(makeSleepRecord({ durationHours: 4, sleepScore: 0.39 }));
    expect(result).toBeNull();
  });

  it("applies nap multiplier (0.15x)", () => {
    const main = classifyAnchor(makeSleepRecord({ durationHours: 8, sleepScore: 0.85, isMainSleep: true }));
    const nap = classifyAnchor(makeSleepRecord({ durationHours: 8, sleepScore: 0.85, isMainSleep: false }));
    expect(main).not.toBeNull();
    expect(nap).not.toBeNull();
    expect(nap!.weight).toBeCloseTo(main!.weight * 0.15, 6);
  });

  it("caps duration factor at 1 for 9h+", () => {
    const at9 = classifyAnchor(makeSleepRecord({ durationHours: 9, sleepScore: 0.85 }));
    const at12 = classifyAnchor(makeSleepRecord({ durationHours: 12, sleepScore: 0.85 }));
    // durFactor = min(1, (dur-4)/5): at 9h → 1.0, at 12h → 1.0 (capped)
    expect(at9!.weight).toEqual(at12!.weight);
  });

  it("tier A weight is higher than tier B for same quality", () => {
    const a = classifyAnchor(makeSleepRecord({ durationHours: 8, sleepScore: 0.8 }));
    const b = classifyAnchor(makeSleepRecord({ durationHours: 5.5, sleepScore: 0.8 }));
    expect(a!.weight).toBeGreaterThan(b!.weight);
  });
});

// ── sleepMidpointHour ───────────────────────────────────────────────

describe("sleepMidpointHour", () => {
  it("computes midpoint offset from epoch", () => {
    const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
    const record = makeSleepRecord({
      startTime: new Date("2024-01-01T22:00:00"),
      endTime: new Date("2024-01-02T06:00:00"),
      durationMs: 8 * 3_600_000,
    });
    const mid = sleepMidpointHour(record, firstDateMs);
    // midpoint should be at 2 AM = 26 hours from midnight day 0
    expect(mid).toBeCloseTo(26, 1);
  });

  it("handles multi-day offset", () => {
    const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
    const record = makeSleepRecord({
      startTime: new Date("2024-01-03T23:00:00"),
      endTime: new Date("2024-01-04T07:00:00"),
      durationMs: 8 * 3_600_000,
    });
    const mid = sleepMidpointHour(record, firstDateMs);
    // midpoint = Jan 4 03:00 → 75 hours from epoch
    expect(mid).toBeCloseTo(75, 1);
  });
});

// ── localPairwiseUnwrap ─────────────────────────────────────────────

describe("localPairwiseUnwrap", () => {
  it("does not mutate input", () => {
    const input = [23, 1, 3];
    const copy = [...input];
    localPairwiseUnwrap(input);
    expect(input).toEqual(copy);
  });

  it("unwraps forward wrap (23 → 1 becomes 23 → 25)", () => {
    const result = localPairwiseUnwrap([23, 1]);
    expect(result[0]).toBe(23);
    expect(result[1]).toBe(25);
  });

  it("unwraps backward wrap", () => {
    const result = localPairwiseUnwrap([1, 23]);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(-1);
  });

  it("handles drifting N24 sequence", () => {
    // Midpoints drifting ~0.5h/day over 24h boundary
    const mids = [22, 22.5, 23, 23.5, 0.0, 0.5, 1.0, 1.5];
    const result = localPairwiseUnwrap(mids);
    // Should be monotonically increasing
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!).toBeGreaterThan(result[i - 1]!);
    }
    // Last should be ~25.5
    expect(result[result.length - 1]).toBeCloseTo(25.5, 1);
  });

  it("leaves already-continuous sequence unchanged", () => {
    const mids = [2, 3, 4, 5, 6];
    const result = localPairwiseUnwrap(mids);
    expect(result).toEqual(mids);
  });
});

// ── weightedLinearRegression ────────────────────────────────────────

describe("weightedLinearRegression", () => {
  it("fits a perfect line (y = 2x + 1)", () => {
    const pts = [
      { x: 0, y: 1, w: 1 },
      { x: 1, y: 3, w: 1 },
      { x: 2, y: 5, w: 1 },
    ];
    const { slope, intercept } = weightedLinearRegression(pts);
    expect(slope).toBeCloseTo(2, 6);
    expect(intercept).toBeCloseTo(1, 6);
  });

  it("handles single point", () => {
    const pts = [{ x: 5, y: 10, w: 1 }];
    const { slope, intercept } = weightedLinearRegression(pts);
    expect(slope).toBe(0);
    expect(intercept).toBeCloseTo(10, 6);
  });

  it("handles zero weights gracefully", () => {
    const pts = [
      { x: 0, y: 1, w: 0 },
      { x: 1, y: 3, w: 0 },
    ];
    const { slope, intercept } = weightedLinearRegression(pts);
    // All-zero weights → slope=0, intercept=0
    expect(slope).toBe(0);
    expect(intercept).toBe(0);
  });

  it("respects weights (high-weight point dominates)", () => {
    const pts = [
      { x: 0, y: 0, w: 100 },
      { x: 1, y: 1, w: 100 },
      { x: 2, y: 100, w: 0.01 }, // outlier with tiny weight
    ];
    const { slope } = weightedLinearRegression(pts);
    expect(slope).toBeCloseTo(1, 0); // dominated by w=100 points
  });

  it("handles collinear x (singular denom)", () => {
    const pts = [
      { x: 5, y: 10, w: 1 },
      { x: 5, y: 20, w: 1 },
    ];
    const { slope, intercept } = weightedLinearRegression(pts);
    expect(slope).toBe(0);
    expect(intercept).toBeCloseTo(15, 6);
  });
});

// ── robustWeightedRegression ────────────────────────────────────────

describe("robustWeightedRegression", () => {
  it("converges on clean data to same result as WLS", () => {
    const pts = [
      { x: 0, y: 1, w: 1 },
      { x: 1, y: 3, w: 1 },
      { x: 2, y: 5, w: 1 },
      { x: 3, y: 7, w: 1 },
    ];
    const wls = weightedLinearRegression(pts);
    const robust = robustWeightedRegression(pts);
    expect(robust.slope).toBeCloseTo(wls.slope, 3);
    expect(robust.intercept).toBeCloseTo(wls.intercept, 3);
  });

  it("rejects outlier better than plain WLS", () => {
    const pts = [
      { x: 0, y: 0, w: 1 },
      { x: 1, y: 1, w: 1 },
      { x: 2, y: 2, w: 1 },
      { x: 3, y: 3, w: 1 },
      { x: 4, y: 4, w: 1 },
      { x: 5, y: 50, w: 1 }, // outlier
    ];
    const wls = weightedLinearRegression(pts);
    const robust = robustWeightedRegression(pts);
    // Robust should be closer to true slope of 1
    expect(Math.abs(robust.slope - 1)).toBeLessThan(Math.abs(wls.slope - 1));
  });

  it("handles <2 points", () => {
    const single = robustWeightedRegression([{ x: 1, y: 5, w: 1 }]);
    expect(single.slope).toBe(0);
    expect(single.intercept).toBe(5);

    const empty = robustWeightedRegression([]);
    expect(empty.slope).toBe(0);
    expect(empty.intercept).toBe(0);
  });
});

// ── gaussian ────────────────────────────────────────────────────────

describe("gaussian", () => {
  it("returns 1.0 at distance=0", () => {
    expect(gaussian(0, 14)).toBe(1);
  });

  it("returns ~0.5 at distance=sigma*sqrt(2*ln2) ≈ 1.177*sigma", () => {
    const sigma = 14;
    const halfDist = sigma * Math.sqrt(2 * Math.log(2));
    expect(gaussian(halfDist, sigma)).toBeCloseTo(0.5, 2);
  });

  it("approaches 0 for large distance", () => {
    expect(gaussian(100, 14)).toBeLessThan(0.001);
  });

  it("is symmetric", () => {
    expect(gaussian(5, 14)).toBe(gaussian(-5, 14));
  });
});

// ── computeMedianSpacing ────────────────────────────────────────────

describe("computeMedianSpacing", () => {
  // Anchors are typed internally — create minimal objects
  const makeAnchors = (dayNumbers: number[]) =>
    dayNumbers.map((d) => ({ dayNumber: d })) as Parameters<typeof computeMedianSpacing>[0];

  it("returns 7 for <2 anchors", () => {
    expect(computeMedianSpacing(makeAnchors([]))).toBe(7);
    expect(computeMedianSpacing(makeAnchors([5]))).toBe(7);
  });

  it("computes median of even spacing", () => {
    // Days 0, 2, 4, 6 → spacings [2,2,2] → median 2
    expect(computeMedianSpacing(makeAnchors([0, 2, 4, 6]))).toBe(2);
  });

  it("computes median of uneven spacing", () => {
    // Days 0, 1, 1, 5, 10 → spacings [1, 0, 4, 5] → sorted [0, 1, 4, 5] → median at idx 2 = 4
    expect(computeMedianSpacing(makeAnchors([0, 1, 1, 5, 10]))).toBe(4);
  });
});
