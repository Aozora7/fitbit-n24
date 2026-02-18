import { describe, it, expect } from "vitest";
import { computeAnchorWeight, sleepMidpointHour, prepareAnchors } from "../anchors";
import type { SleepRecord } from "../../../../api/types";

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

describe("computeAnchorWeight", () => {
    it("returns higher weight for higher quality", () => {
        const high = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.9 }));
        const low = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.5 }));
        expect(high).toBeGreaterThan(low!);
    });

    it("returns higher weight for longer duration (up to 7h)", () => {
        const short = computeAnchorWeight(makeSleepRecord({ durationHours: 5, sleepScore: 0.85 }));
        const long = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.85 }));
        expect(long).toBeGreaterThan(short!);
    });

    it("caps duration factor at 1 for 7h+", () => {
        const at7 = computeAnchorWeight(makeSleepRecord({ durationHours: 7, sleepScore: 0.85 }));
        const at10 = computeAnchorWeight(makeSleepRecord({ durationHours: 10, sleepScore: 0.85 }));
        expect(at7).toBeCloseTo(at10!, 6);
    });

    it("applies nap multiplier (0.15x) for non-main sleep", () => {
        const main = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.85, isMainSleep: true }));
        const nap = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.85, isMainSleep: false }));
        expect(nap).toBeCloseTo(main! * 0.15, 6);
    });

    it("returns null for short duration (< 4h)", () => {
        const result = computeAnchorWeight(makeSleepRecord({ durationHours: 3.5, sleepScore: 0.85 }));
        expect(result).toBeNull();
    });

    it("returns null for very low quality", () => {
        const result = computeAnchorWeight(makeSleepRecord({ durationHours: 8, sleepScore: 0.02 }));
        expect(result).toBeNull();
    });

    it("returns null for low combined weight", () => {
        const result = computeAnchorWeight(makeSleepRecord({ durationHours: 4.5, sleepScore: 0.1 }));
        expect(result).toBeNull();
    });

    it("weight scales linearly with duration between 4h and 7h", () => {
        const w4 = computeAnchorWeight(makeSleepRecord({ durationHours: 4, sleepScore: 1.0 }));
        const w5 = computeAnchorWeight(makeSleepRecord({ durationHours: 5, sleepScore: 1.0 }));
        const w6 = computeAnchorWeight(makeSleepRecord({ durationHours: 6, sleepScore: 1.0 }));
        const w7 = computeAnchorWeight(makeSleepRecord({ durationHours: 7, sleepScore: 1.0 }));

        expect(w4).toBeCloseTo(0, 6);
        expect(w5).toBeCloseTo(1 / 3, 4);
        expect(w6).toBeCloseTo(2 / 3, 4);
        expect(w7).toBeCloseTo(1, 6);
    });

    it("exactly 4h duration returns weight near zero", () => {
        const result = computeAnchorWeight(makeSleepRecord({ durationHours: 4, sleepScore: 0.85 }));
        expect(result).toBeCloseTo(0, 6);
    });
});

describe("sleepMidpointHour", () => {
    it("computes midpoint hour relative to first date", () => {
        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const record = makeSleepRecord({
            startTime: new Date("2024-01-01T22:00:00"),
            endTime: new Date("2024-01-02T06:00:00"),
            durationMs: 8 * 3_600_000,
        });

        const mid = sleepMidpointHour(record, firstDateMs);

        expect(mid).toBeCloseTo(26, 1);
    });

    it("handles multi-day offset from epoch", () => {
        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const record = makeSleepRecord({
            startTime: new Date("2024-01-03T23:00:00"),
            endTime: new Date("2024-01-04T07:00:00"),
            durationMs: 8 * 3_600_000,
        });

        const mid = sleepMidpointHour(record, firstDateMs);

        expect(mid).toBeCloseTo(75, 1);
    });

    it("computes midpoint at start time for zero duration", () => {
        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const record = makeSleepRecord({
            startTime: new Date("2024-01-01T12:00:00"),
            endTime: new Date("2024-01-01T12:00:00"),
            durationMs: 0,
        });

        const mid = sleepMidpointHour(record, firstDateMs);

        expect(mid).toBeCloseTo(12, 1);
    });
});

describe("prepareAnchors", () => {
    it("returns empty for empty input", () => {
        const result = prepareAnchors([], Date.now());
        expect(result).toHaveLength(0);
    });

    it("filters out low-weight records", () => {
        const records = [
            makeSleepRecord({ logId: 1, dateOfSleep: "2024-01-01", durationHours: 3, sleepScore: 0.85 }),
            makeSleepRecord({ logId: 2, dateOfSleep: "2024-01-02", durationHours: 8, sleepScore: 0.85 }),
        ];

        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors(records, firstDateMs);

        expect(anchors).toHaveLength(1);
        expect(anchors[0]!.dayNumber).toBe(1);
    });

    it("selects best anchor per date (highest weight)", () => {
        const records = [
            makeSleepRecord({ logId: 1, dateOfSleep: "2024-01-01", durationHours: 8, sleepScore: 0.9 }),
            makeSleepRecord({ logId: 2, dateOfSleep: "2024-01-01", durationHours: 6, sleepScore: 0.7 }),
            makeSleepRecord({ logId: 3, dateOfSleep: "2024-01-01", durationHours: 5, sleepScore: 0.5 }),
        ];

        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors(records, firstDateMs);

        expect(anchors).toHaveLength(1);
        expect(anchors[0]!.weight).toBeCloseTo(0.9, 4);
    });

    it("sorts anchors by dayNumber ascending", () => {
        const records = [
            makeSleepRecord({ logId: 1, dateOfSleep: "2024-01-03", startTime: new Date("2024-01-03T23:00:00") }),
            makeSleepRecord({ logId: 2, dateOfSleep: "2024-01-01", startTime: new Date("2024-01-01T23:00:00") }),
            makeSleepRecord({ logId: 3, dateOfSleep: "2024-01-02", startTime: new Date("2024-01-02T23:00:00") }),
        ];

        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors(records, firstDateMs);

        expect(anchors[0]!.dayNumber).toBe(0);
        expect(anchors[1]!.dayNumber).toBe(1);
        expect(anchors[2]!.dayNumber).toBe(2);
    });

    it("computes correct dayNumber from firstDateMs", () => {
        const records = [
            makeSleepRecord({ logId: 1, dateOfSleep: "2024-01-01" }),
            makeSleepRecord({ logId: 2, dateOfSleep: "2024-01-05" }),
            makeSleepRecord({ logId: 3, dateOfSleep: "2024-01-10" }),
        ];

        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors(records, firstDateMs);

        expect(anchors[0]!.dayNumber).toBe(0);
        expect(anchors[1]!.dayNumber).toBe(4);
        expect(anchors[2]!.dayNumber).toBe(9);
    });

    it("includes record reference in anchor", () => {
        const record = makeSleepRecord({ logId: 123 });
        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors([record], firstDateMs);

        expect(anchors[0]!.record.logId).toBe(123);
    });

    it("handles nap records (non-main sleep) with reduced weight", () => {
        const records = [
            makeSleepRecord({ logId: 1, dateOfSleep: "2024-01-01", isMainSleep: true, sleepScore: 0.85 }),
            makeSleepRecord({ logId: 2, dateOfSleep: "2024-01-01", isMainSleep: false, sleepScore: 0.85 }),
        ];

        const firstDateMs = new Date("2024-01-01T00:00:00").getTime();
        const anchors = prepareAnchors(records, firstDateMs);

        expect(anchors).toHaveLength(1);
        expect(anchors[0]!.record.isMainSleep).toBe(true);
    });
});
