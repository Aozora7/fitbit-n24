import { describe, it, expect } from "vitest";
import { calculateSleepScore } from "../calculateSleepScore";
import type { RawSleepRecordV12 } from "../../api/types";

function makeRawRecord(overrides: Partial<RawSleepRecordV12> = {}): RawSleepRecordV12 {
    return {
        dateOfSleep: "2024-03-15",
        duration: 8 * 3_600_000,
        efficiency: 90,
        startTime: "2024-03-15T23:00:00",
        endTime: "2024-03-16T07:00:00",
        infoCode: 0,
        isMainSleep: true,
        logId: 1,
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

describe("calculateSleepScore", () => {
    it("returns value in [0, 1]", () => {
        const score = calculateSleepScore(makeRawRecord());
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it("short sleep (2h) scores lower than normal sleep (8h)", () => {
        const short = calculateSleepScore(
            makeRawRecord({
                minutesAsleep: 120,
                duration: 2.5 * 3_600_000,
                timeInBed: 150,
            })
        );
        const normal = calculateSleepScore(makeRawRecord());
        expect(short).toBeLessThan(normal);
    });

    it("very long sleep (13h) scores low", () => {
        const score = calculateSleepScore(
            makeRawRecord({
                minutesAsleep: 780,
                duration: 14 * 3_600_000,
                timeInBed: 840,
            })
        );
        // durationScore = 0 for >12h, but deep+REM still contribute
        expect(score).toBeLessThan(0.85);
    });

    it("optimal 7-9h range scores highest", () => {
        const at7h = calculateSleepScore(makeRawRecord({ minutesAsleep: 420 }));
        const at8h = calculateSleepScore(makeRawRecord({ minutesAsleep: 480 }));
        const at4h = calculateSleepScore(makeRawRecord({ minutesAsleep: 240 }));
        // 7-9h should score higher than 4h
        expect(at7h).toBeGreaterThan(at4h);
        expect(at8h).toBeGreaterThan(at4h);
    });

    it("high wake percentage lowers score", () => {
        const lowWake = calculateSleepScore(
            makeRawRecord({
                levels: {
                    data: [],
                    shortData: [],
                    summary: {
                        deep: { count: 4, minutes: 80, thirtyDayAvgMinutes: 75 },
                        light: { count: 20, minutes: 200, thirtyDayAvgMinutes: 210 },
                        rem: { count: 5, minutes: 100, thirtyDayAvgMinutes: 95 },
                        wake: { count: 5, minutes: 20, thirtyDayAvgMinutes: 25 },
                    },
                },
            })
        );
        const highWake = calculateSleepScore(
            makeRawRecord({
                levels: {
                    data: [],
                    shortData: [],
                    summary: {
                        deep: { count: 4, minutes: 80, thirtyDayAvgMinutes: 75 },
                        light: { count: 20, minutes: 200, thirtyDayAvgMinutes: 210 },
                        rem: { count: 5, minutes: 100, thirtyDayAvgMinutes: 95 },
                        wake: { count: 30, minutes: 180, thirtyDayAvgMinutes: 45 },
                    },
                },
            })
        );
        expect(lowWake).toBeGreaterThan(highWake);
    });

    it("handles classic type records (no stages)", () => {
        const score = calculateSleepScore(
            makeRawRecord({
                type: "classic",
                levels: {
                    data: [],
                    shortData: [],
                    summary: {} as any,
                },
            })
        );
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it("handles manual log type", () => {
        const score = calculateSleepScore(
            makeRawRecord({
                logType: "manual",
                type: "classic",
                levels: {
                    data: [],
                    shortData: [],
                    summary: {} as any,
                },
            })
        );
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
    });

    it("score is always clamped to [0, 1]", () => {
        // Extreme edge case: 0 minutes asleep, max wake
        const extreme = calculateSleepScore(
            makeRawRecord({
                minutesAsleep: 0,
                duration: 60_000, // 1 min
                timeInBed: 1,
                minutesAwake: 1,
                levels: {
                    data: [],
                    shortData: [],
                    summary: {
                        deep: { count: 0, minutes: 0, thirtyDayAvgMinutes: 0 },
                        light: { count: 0, minutes: 0, thirtyDayAvgMinutes: 0 },
                        rem: { count: 0, minutes: 0, thirtyDayAvgMinutes: 0 },
                        wake: { count: 1, minutes: 1, thirtyDayAvgMinutes: 0 },
                    },
                },
            })
        );
        expect(extreme).toBeGreaterThanOrEqual(0);
        expect(extreme).toBeLessThanOrEqual(1);
    });
});
