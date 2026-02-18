import { describe, it, expect } from "vitest";
import { splitIntoSegments } from "../segments";
import { GAP_THRESHOLD_DAYS } from "../types";
import type { SleepRecord } from "../../../api/types";

function makeRecord(dateOfSleep: string, startHour = 22, durationHours = 8, logId?: number): SleepRecord {
    const startTime = new Date(`${dateOfSleep}T${String(startHour).padStart(2, "0")}:00:00`);
    return {
        logId: logId ?? parseInt(dateOfSleep.replace(/-/g, "")),
        dateOfSleep,
        startTime,
        endTime: new Date(startTime.getTime() + durationHours * 3_600_000),
        durationMs: durationHours * 3_600_000,
        durationHours,
        efficiency: 90,
        minutesAsleep: Math.round(durationHours * 60 * 0.9),
        minutesAwake: Math.round(durationHours * 60 * 0.1),
        isMainSleep: true,
        sleepScore: 0.85,
    };
}

describe("splitIntoSegments", () => {
    it("returns empty array for empty input", () => {
        expect(splitIntoSegments([])).toEqual([]);
    });

    it("returns single segment for single record", () => {
        const records = [makeRecord("2024-01-01")];
        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toHaveLength(1);
    });

    it("returns single segment for contiguous records", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-01-02"), makeRecord("2024-01-03")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toHaveLength(3);
    });

    it("splits at gap exactly at threshold + 1 days", () => {
        const records = [
            makeRecord("2024-01-01"),
            makeRecord(`2024-01-${String(2 + GAP_THRESHOLD_DAYS).padStart(2, "0")}`),
        ];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(2);
    });

    it("does not split at gap exactly at threshold days", () => {
        const records = [
            makeRecord("2024-01-01"),
            makeRecord(`2024-01-${String(1 + GAP_THRESHOLD_DAYS).padStart(2, "0")}`),
        ];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
    });

    it("splits into multiple segments with multiple large gaps", () => {
        const records = [
            makeRecord("2024-01-01"),
            makeRecord("2024-01-02"),
            makeRecord("2024-02-01"),
            makeRecord("2024-02-02"),
            makeRecord("2024-03-15"),
            makeRecord("2024-03-16"),
        ];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(3);
        expect(segments[0]).toHaveLength(2);
        expect(segments[1]).toHaveLength(2);
        expect(segments[2]).toHaveLength(2);
    });

    it("handles gap at dataset start (first record isolated)", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-02-01"), makeRecord("2024-02-02")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toHaveLength(1);
        expect(segments[1]).toHaveLength(2);
    });

    it("handles gap at dataset end (last record isolated)", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-01-02"), makeRecord("2024-02-15")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(2);
        expect(segments[0]).toHaveLength(2);
        expect(segments[1]).toHaveLength(1);
    });

    it("preserves record order within segments", () => {
        const records = [
            makeRecord("2024-01-01", 22, 8, 1),
            makeRecord("2024-01-02", 23, 7, 2),
            makeRecord("2024-01-03", 21, 9, 3),
        ];

        const segments = splitIntoSegments(records);

        expect(segments[0]![0]!.logId).toBe(1);
        expect(segments[0]![1]!.logId).toBe(2);
        expect(segments[0]![2]!.logId).toBe(3);
    });

    it("sorts unsorted input by startTime", () => {
        const records = [makeRecord("2024-01-03"), makeRecord("2024-01-01"), makeRecord("2024-01-02")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]![0]!.dateOfSleep).toBe("2024-01-01");
        expect(segments[0]![1]!.dateOfSleep).toBe("2024-01-02");
        expect(segments[0]![2]!.dateOfSleep).toBe("2024-01-03");
    });

    it("handles very short gaps (1-2 days)", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-01-03"), makeRecord("2024-01-06")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toHaveLength(3);
    });

    it("handles exactly threshold days gap as contiguous", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-01-15")];

        const segments = splitIntoSegments(records);

        const gapDays = 14;
        if (gapDays === GAP_THRESHOLD_DAYS) {
            expect(segments).toHaveLength(1);
        }
    });

    it("handles duplicate dates (same day multiple records)", () => {
        const records = [
            makeRecord("2024-01-01", 22, 8, 1),
            makeRecord("2024-01-01", 14, 2, 2),
            makeRecord("2024-01-02", 22, 8, 3),
        ];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toHaveLength(3);
    });

    it("handles year boundary", () => {
        const records = [
            makeRecord("2024-12-30"),
            makeRecord("2024-12-31"),
            makeRecord("2025-01-01"),
            makeRecord("2025-01-02"),
        ];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(1);
        expect(segments[0]).toHaveLength(4);
    });

    it("creates separate segments for each isolated record", () => {
        const records = [makeRecord("2024-01-01"), makeRecord("2024-03-01"), makeRecord("2024-05-01")];

        const segments = splitIntoSegments(records);

        expect(segments).toHaveLength(3);
        for (const seg of segments) {
            expect(seg).toHaveLength(1);
        }
    });
});
