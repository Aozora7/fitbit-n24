import { describe, it, expect } from "vitest";
import { parseSleepData } from "../loadLocalData";

// ── Minimal valid v1.2 record ───────────────────────────────────────

function makeV12Raw(overrides: Record<string, unknown> = {}) {
    return {
        dateOfSleep: "2024-03-15",
        duration: 8 * 3_600_000,
        efficiency: 90,
        startTime: "2024-03-15T23:00:00",
        endTime: "2024-03-16T07:00:00",
        infoCode: 0,
        isMainSleep: true,
        logId: 1001,
        logType: "auto_detected",
        minutesAfterWakeup: 0,
        minutesAsleep: 420,
        minutesAwake: 30,
        minutesToFallAsleep: 10,
        timeInBed: 480,
        type: "stages",
        levels: {
            data: [],
            shortData: [],
            summary: {
                deep: { count: 4, minutes: 80, thirtyDayAvgMinutes: 75 },
                light: { count: 20, minutes: 200, thirtyDayAvgMinutes: 210 },
                rem: { count: 5, minutes: 100, thirtyDayAvgMinutes: 95 },
                wake: { count: 15, minutes: 40, thirtyDayAvgMinutes: 45 },
            },
        },
        ...overrides,
    };
}

// ── Format: single page { sleep: [...] } ────────────────────────────

describe("parseSleepData — single page format", () => {
    it("parses { sleep: [...] } format", () => {
        const data = { sleep: [makeV12Raw()] };
        const records = parseSleepData(data);
        expect(records).toHaveLength(1);
        expect(records[0]!.logId).toBe(1001);
        expect(records[0]!.startTime).toBeInstanceOf(Date);
    });
});

// ── Format: multi-page [{ sleep: [...] }, ...] ──────────────────────

describe("parseSleepData — multi-page format", () => {
    it("parses array of pages", () => {
        const data = [
            { sleep: [makeV12Raw({ logId: 1 }), makeV12Raw({ logId: 2 })] },
            { sleep: [makeV12Raw({ logId: 3 })] },
        ];
        const records = parseSleepData(data);
        expect(records).toHaveLength(3);
    });
});

// ── Format: flat array of records ───────────────────────────────────

describe("parseSleepData — flat array format", () => {
    it("parses flat array of v1.2 records", () => {
        const data = [makeV12Raw({ logId: 10 }), makeV12Raw({ logId: 11 })];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });
});

// ── Exported (internal) format ──────────────────────────────────────

describe("parseSleepData — exported format", () => {
    it("round-trips through export format (durationMs field)", () => {
        const original = parseSleepData({ sleep: [makeV12Raw()] });
        // Simulate JSON round-trip (Date → string)
        const serialized = JSON.parse(JSON.stringify(original));
        const reparsed = parseSleepData(serialized);
        expect(reparsed).toHaveLength(1);
        expect(reparsed[0]!.logId).toBe(original[0]!.logId);
        expect(reparsed[0]!.startTime).toBeInstanceOf(Date);
        expect(reparsed[0]!.durationMs).toBe(original[0]!.durationMs);
    });
});

// ── Deduplication ───────────────────────────────────────────────────

describe("parseSleepData — deduplication", () => {
    it("removes duplicate logIds", () => {
        const data = [
            makeV12Raw({ logId: 100 }),
            makeV12Raw({ logId: 100 }), // duplicate
            makeV12Raw({ logId: 101 }),
        ];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });
});

// ── Sort order ──────────────────────────────────────────────────────

describe("parseSleepData — sort order", () => {
    it("sorts by start time ascending", () => {
        const data = [
            makeV12Raw({ logId: 1, startTime: "2024-03-17T23:00:00" }),
            makeV12Raw({ logId: 2, startTime: "2024-03-15T23:00:00" }),
            makeV12Raw({ logId: 3, startTime: "2024-03-16T23:00:00" }),
        ];
        const records = parseSleepData(data);
        for (let i = 1; i < records.length; i++) {
            expect(records[i]!.startTime.getTime()).toBeGreaterThanOrEqual(records[i - 1]!.startTime.getTime());
        }
    });
});

// ── Error handling ──────────────────────────────────────────────────

describe("parseSleepData — error handling", () => {
    it("throws on unrecognized format", () => {
        expect(() => parseSleepData("not an object")).toThrow();
        expect(() => parseSleepData({ foo: "bar" })).toThrow();
    });

    it("returns empty for empty array", () => {
        expect(parseSleepData([])).toEqual([]);
    });
});
