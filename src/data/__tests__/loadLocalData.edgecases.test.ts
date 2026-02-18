import { describe, it, expect } from "vitest";
import { parseSleepData } from "../loadLocalData";
import type { RawSleepRecordV12 } from "../../api/types";

function makeV12Raw(overrides: Record<string, unknown> = {}): RawSleepRecordV12 {
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
    } as RawSleepRecordV12;
}

function makeExportedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        logId: 1001,
        dateOfSleep: "2024-03-15",
        startTime: "2024-03-15T23:00:00",
        endTime: "2024-03-16T07:00:00",
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

describe("parseSleepData — format detection", () => {
    it("parses { sleep: [...] } format", () => {
        const data = { sleep: [makeV12Raw()] };
        const records = parseSleepData(data);
        expect(records).toHaveLength(1);
        expect(records[0]!.logId).toBe(1001);
    });

    it("parses array of pages format", () => {
        const data = [{ sleep: [makeV12Raw({ logId: 1 })] }, { sleep: [makeV12Raw({ logId: 2 })] }];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });

    it("parses flat array of v1.2 records", () => {
        const data = [makeV12Raw({ logId: 10 }), makeV12Raw({ logId: 11 })];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });

    it("parses flat array of exported records", () => {
        const data = [makeExportedRecord({ logId: 20 }), makeExportedRecord({ logId: 21 })];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });
});

describe("parseSleepData — deduplication", () => {
    it("removes duplicate logIds", () => {
        const data = [makeV12Raw({ logId: 100 }), makeV12Raw({ logId: 100 }), makeV12Raw({ logId: 101 })];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });

    it("keeps first occurrence of duplicate logId", () => {
        const data = [makeV12Raw({ logId: 100, efficiency: 90 }), makeV12Raw({ logId: 100, efficiency: 80 })];
        const records = parseSleepData(data);
        expect(records).toHaveLength(1);
        expect(records[0]!.efficiency).toBe(90);
    });
});

describe("parseSleepData — sort order", () => {
    it("sorts by startTime ascending", () => {
        const data = [
            makeV12Raw({ logId: 1, startTime: "2024-03-17T23:00:00" }),
            makeV12Raw({ logId: 2, startTime: "2024-03-15T23:00:00" }),
            makeV12Raw({ logId: 3, startTime: "2024-03-16T23:00:00" }),
        ];
        const records = parseSleepData(data);

        expect(records[0]!.logId).toBe(2);
        expect(records[1]!.logId).toBe(3);
        expect(records[2]!.logId).toBe(1);
    });
});

describe("parseSleepData — error handling", () => {
    it("throws on unrecognized format (string)", () => {
        expect(() => parseSleepData("not an object")).toThrow();
    });

    it("throws on unrecognized format (wrong object)", () => {
        expect(() => parseSleepData({ foo: "bar" })).toThrow();
    });

    it("throws on unrecognized record format", () => {
        expect(() => parseSleepData([{ someUnknownField: 123 }])).toThrow();
    });

    it("returns empty for empty array", () => {
        expect(parseSleepData([])).toEqual([]);
    });

    it("returns empty for { sleep: [] }", () => {
        expect(parseSleepData({ sleep: [] })).toEqual([]);
    });
});

describe("parseSleepData — date parsing", () => {
    it("parses startTime and endTime as Date objects", () => {
        const data = { sleep: [makeV12Raw()] };
        const records = parseSleepData(data);

        expect(records[0]!.startTime).toBeInstanceOf(Date);
        expect(records[0]!.endTime).toBeInstanceOf(Date);
    });

    it("handles ISO date strings", () => {
        const data = {
            sleep: [
                makeV12Raw({
                    startTime: "2024-01-15T22:30:00.000",
                    endTime: "2024-01-16T06:45:00.000",
                }),
            ],
        };
        const records = parseSleepData(data);

        expect(records[0]!.startTime.toISOString()).toContain("2024-01-15");
        expect(records[0]!.endTime.toISOString()).toContain("2024-01-16");
    });
});

describe("parseSleepData — duration handling", () => {
    it("computes durationMs from duration field (v1.2)", () => {
        const data = { sleep: [makeV12Raw({ duration: 7 * 3_600_000 })] };
        const records = parseSleepData(data);

        expect(records[0]!.durationMs).toBe(7 * 3_600_000);
        expect(records[0]!.durationHours).toBeCloseTo(7, 4);
    });

    it("preserves durationMs from exported format", () => {
        const data = [makeExportedRecord({ durationMs: 6 * 3_600_000, durationHours: 6 })];
        const records = parseSleepData(data);

        expect(records[0]!.durationMs).toBe(6 * 3_600_000);
        expect(records[0]!.durationHours).toBe(6);
    });
});

describe("parseSleepData — stage data handling", () => {
    it("parses stage summary from v1.2 stages type", () => {
        const data = { sleep: [makeV12Raw()] };
        const records = parseSleepData(data);

        expect(records[0]!.stages).toBeDefined();
        expect(records[0]!.stages!.deep).toBe(80);
        expect(records[0]!.stages!.light).toBe(200);
        expect(records[0]!.stages!.rem).toBe(100);
        expect(records[0]!.stages!.wake).toBe(40);
    });

    it("handles classic type without stage summary", () => {
        const data = {
            sleep: [
                makeV12Raw({
                    type: "classic",
                    levels: {
                        data: [],
                        shortData: [],
                        summary: {
                            asleep: { count: 1, minutes: 400 },
                            restless: { count: 5, minutes: 30 },
                            awake: { count: 2, minutes: 20 },
                        },
                    },
                }),
            ],
        };
        const records = parseSleepData(data);

        expect(records[0]!.stages).toBeUndefined();
    });

    it("handles missing levels field", () => {
        const data = {
            sleep: [makeV12Raw({ levels: undefined })],
        };
        const records = parseSleepData(data);

        expect(records[0]!.stages).toBeUndefined();
    });

    it("preserves stageData from v1.2", () => {
        const stageData = [
            { dateTime: "2024-03-15T23:00:00", level: "light", seconds: 1200 },
            { dateTime: "2024-03-15T23:20:00", level: "deep", seconds: 1800 },
        ];
        const data = {
            sleep: [
                makeV12Raw({
                    levels: {
                        data: stageData,
                        shortData: [],
                        summary: {
                            deep: { count: 1, minutes: 30 },
                            light: { count: 1, minutes: 20 },
                            rem: { count: 0, minutes: 0 },
                            wake: { count: 0, minutes: 0 },
                        },
                    },
                }),
            ],
        };
        const records = parseSleepData(data);

        expect(records[0]!.stageData).toBeDefined();
        expect(records[0]!.stageData!.length).toBe(2);
    });
});

describe("parseSleepData — isMainSleep handling", () => {
    it("preserves isMainSleep true", () => {
        const data = { sleep: [makeV12Raw({ isMainSleep: true })] };
        const records = parseSleepData(data);
        expect(records[0]!.isMainSleep).toBe(true);
    });

    it("preserves isMainSleep false (nap)", () => {
        const data = { sleep: [makeV12Raw({ isMainSleep: false })] };
        const records = parseSleepData(data);
        expect(records[0]!.isMainSleep).toBe(false);
    });

    it("defaults isMainSleep to true for exported format", () => {
        const data = [makeExportedRecord({ isMainSleep: undefined })];
        const records = parseSleepData(data);
        expect(records[0]!.isMainSleep).toBe(true);
    });
});

describe("parseSleepData — sleepScore handling", () => {
    it("computes sleepScore for v1.2 format", () => {
        const data = { sleep: [makeV12Raw({ efficiency: 95, minutesAsleep: 480 })] };
        const records = parseSleepData(data);
        expect(records[0]!.sleepScore).toBeGreaterThanOrEqual(0);
        expect(records[0]!.sleepScore).toBeLessThanOrEqual(1);
    });

    it("preserves sleepScore from exported format", () => {
        const data = [makeExportedRecord({ sleepScore: 0.75 })];
        const records = parseSleepData(data);
        expect(records[0]!.sleepScore).toBe(0.75);
    });

    it("defaults sleepScore to 0 for exported format without it", () => {
        const data = [makeExportedRecord({ sleepScore: undefined })];
        const records = parseSleepData(data);
        expect(records[0]!.sleepScore).toBe(0);
    });
});

describe("parseSleepData — logId handling", () => {
    it("handles numeric logId", () => {
        const data = { sleep: [makeV12Raw({ logId: 12345 })] };
        const records = parseSleepData(data);
        expect(records[0]!.logId).toBe(12345);
    });

    it("converts string logId to number", () => {
        const data = { sleep: [makeV12Raw({ logId: "67890" })] };
        const records = parseSleepData(data);
        expect(records[0]!.logId).toBe(67890);
    });
});

describe("parseSleepData — mixed format input", () => {
    it("handles mixed v1.2 and exported records in same array", () => {
        const data = [
            makeV12Raw({ logId: 1, startTime: "2024-01-01T23:00:00" }),
            makeExportedRecord({ logId: 2, startTime: "2024-01-02T23:00:00" }),
        ];
        const records = parseSleepData(data);

        expect(records).toHaveLength(2);
        expect(records[0]!.startTime).toBeInstanceOf(Date);
        expect(records[1]!.startTime).toBeInstanceOf(Date);
    });
});

describe("parseSleepData — pagination field ignored", () => {
    it("ignores pagination field in single page format", () => {
        const data = {
            sleep: [makeV12Raw()],
            pagination: { beforeDate: "2024-01-01", afterDate: null },
        };
        const records = parseSleepData(data);
        expect(records).toHaveLength(1);
    });

    it("ignores pagination in multi-page format", () => {
        const data = [
            { sleep: [makeV12Raw({ logId: 1 })], pagination: {} },
            { sleep: [makeV12Raw({ logId: 2 })], pagination: {} },
        ];
        const records = parseSleepData(data);
        expect(records).toHaveLength(2);
    });
});
