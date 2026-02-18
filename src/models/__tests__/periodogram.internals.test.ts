import { describe, it, expect } from "vitest";
import { computePeriodogram, buildPeriodogramAnchors, type PeriodogramAnchor } from "../periodogram";
import type { SleepRecord } from "../../api/types";

function makeAnchor(dayNumber: number, midpointHour: number, weight = 1): PeriodogramAnchor {
    return { dayNumber, midpointHour, weight };
}

function makeSleepRecord(overrides: Partial<SleepRecord> = {}): SleepRecord {
    const base = new Date("2024-03-15T23:00:00");
    const startTime = overrides.startTime ?? base;
    const endTime = overrides.endTime ?? new Date(base.getTime() + 8 * 3_600_000);
    return {
        logId: 1,
        dateOfSleep: "2024-03-15",
        startTime,
        endTime,
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

describe("buildPeriodogramAnchors", () => {
    it("returns empty for empty input", () => {
        expect(buildPeriodogramAnchors([])).toHaveLength(0);
    });

    it("filters out non-main sleep records", () => {
        const records = [
            makeSleepRecord({ logId: 1, isMainSleep: true, dateOfSleep: "2024-01-01" }),
            makeSleepRecord({ logId: 2, isMainSleep: false, dateOfSleep: "2024-01-01" }),
        ];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors).toHaveLength(1);
    });

    it("filters out short duration records (< 4h)", () => {
        const records = [
            makeSleepRecord({ logId: 1, durationHours: 8, dateOfSleep: "2024-01-01" }),
            makeSleepRecord({ logId: 2, durationHours: 3.5, dateOfSleep: "2024-01-02" }),
        ];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors).toHaveLength(1);
    });

    it("computes correct dayNumber from first date", () => {
        const records = [
            makeSleepRecord({ dateOfSleep: "2024-01-01" }),
            makeSleepRecord({ dateOfSleep: "2024-01-05" }),
            makeSleepRecord({ dateOfSleep: "2024-01-10" }),
        ];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors[0]!.dayNumber).toBe(0);
        expect(anchors[1]!.dayNumber).toBe(4);
        expect(anchors[2]!.dayNumber).toBe(9);
    });

    it("computes midpointHour from sleep times", () => {
        const startTime = new Date("2024-01-01T22:00:00");
        const endTime = new Date("2024-01-02T06:00:00");
        const records = [makeSleepRecord({ startTime, endTime, dateOfSleep: "2024-01-01" })];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors[0]!.midpointHour).toBeCloseTo(26, 1);
    });

    it("computes weight from sleepScore and duration", () => {
        const records = [
            makeSleepRecord({ sleepScore: 1.0, durationHours: 8 }),
            makeSleepRecord({ sleepScore: 0.5, durationHours: 8 }),
            makeSleepRecord({ sleepScore: 1.0, durationHours: 4 }),
        ];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors[0]!.weight).toBeCloseTo(1.0, 2);
        expect(anchors[1]!.weight).toBeCloseTo(0.5, 2);
        expect(anchors[2]!.weight).toBeCloseTo(4 / 7, 2);
    });

    it("sorts by startTime ascending", () => {
        const records = [
            makeSleepRecord({ dateOfSleep: "2024-01-03", startTime: new Date("2024-01-03T22:00:00") }),
            makeSleepRecord({ dateOfSleep: "2024-01-01", startTime: new Date("2024-01-01T22:00:00") }),
            makeSleepRecord({ dateOfSleep: "2024-01-02", startTime: new Date("2024-01-02T22:00:00") }),
        ];

        const anchors = buildPeriodogramAnchors(records);

        expect(anchors[0]!.dayNumber).toBe(0);
        expect(anchors[1]!.dayNumber).toBe(1);
        expect(anchors[2]!.dayNumber).toBe(2);
    });
});

describe("computePeriodogram", () => {
    it("returns empty result for < 3 anchors", () => {
        const anchors = [makeAnchor(0, 3), makeAnchor(1, 4)];

        const result = computePeriodogram(anchors);

        expect(result.points).toHaveLength(0);
        expect(result.peakPower).toBe(0);
        expect(result.peakPeriod).toBe(24);
    });

    it("finds peak near 24.0 for non-drifting data", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3 + Math.sin(d * 0.1) * 0.5));
        }

        const result = computePeriodogram(anchors);

        expect(Math.abs(result.peakPeriod - 24.0)).toBeLessThan(0.3);
    });

    it("finds peak near true period for tau = 24.5", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 150; d++) {
            anchors.push(makeAnchor(d, 3 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        expect(Math.abs(result.peakPeriod - 24.5)).toBeLessThan(0.3);
    });

    it("finds peak near true period for tau = 25.0", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 150; d++) {
            anchors.push(makeAnchor(d, 3 + d * 1.0));
        }

        const result = computePeriodogram(anchors);

        expect(Math.abs(result.peakPeriod - 25.0)).toBeLessThan(0.4);
    });

    it("significance threshold is positive", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3));
        }

        const result = computePeriodogram(anchors);

        expect(result.significanceThreshold).toBeGreaterThan(0);
    });

    it("power24h is computed", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3));
        }

        const result = computePeriodogram(anchors);

        expect(result.power24h).toBeGreaterThan(0);
    });

    it("trimmed points are within valid range", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        for (const pt of result.trimmedPoints) {
            expect(pt.period).toBeGreaterThanOrEqual(23.0);
            expect(pt.period).toBeLessThanOrEqual(26.0);
        }
    });

    it("trimmed points include 24h reference", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        const periods = result.trimmedPoints.map((p) => p.period);
        expect(Math.min(...periods)).toBeLessThanOrEqual(24);
        expect(Math.max(...periods)).toBeGreaterThanOrEqual(24);
    });

    it("handles all same midpoint (uniform phase)", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 50; d++) {
            anchors.push(makeAnchor(d, 3));
        }

        const result = computePeriodogram(anchors);

        expect(result.peakPower).toBeGreaterThan(0);
        expect(result.peakPeriod).toBeCloseTo(24, 1);
    });

    it("handles single day of data (< 3 anchors)", () => {
        const anchors = [makeAnchor(0, 3), makeAnchor(0, 4)];

        const result = computePeriodogram(anchors);

        expect(result.points).toHaveLength(0);
    });

    it("handles weight variation in anchors", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            const weight = d < 50 ? 1.0 : 0.1;
            anchors.push(makeAnchor(d, 3 + d * 0.5, weight));
        }

        const result = computePeriodogram(anchors);

        expect(result.peakPower).toBeGreaterThan(0);
    });

    it("handles anchors spanning less than window size", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 50; d++) {
            anchors.push(makeAnchor(d, 3 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        expect(result.points.length).toBeGreaterThan(0);
        expect(Math.abs(result.peakPeriod - 24.5)).toBeLessThan(0.5);
    });

    it("respects custom period range", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 100; d++) {
            anchors.push(makeAnchor(d, 3 + d * 0.5));
        }

        const result = computePeriodogram(anchors, { minPeriod: 24.0, maxPeriod: 25.0 });

        for (const pt of result.points) {
            expect(pt.period).toBeGreaterThanOrEqual(24.0);
            expect(pt.period).toBeLessThanOrEqual(25.0);
        }
    });

    it("handles negative midpoint hours (unwrapped)", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 50; d++) {
            anchors.push(makeAnchor(d, -3 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        expect(result.points.length).toBeGreaterThan(0);
    });

    it("handles large midpoint hours (unwrapped)", () => {
        const anchors: PeriodogramAnchor[] = [];
        for (let d = 0; d < 50; d++) {
            anchors.push(makeAnchor(d, 50 + d * 0.5));
        }

        const result = computePeriodogram(anchors);

        expect(result.points.length).toBeGreaterThan(0);
    });
});
