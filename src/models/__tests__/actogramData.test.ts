import { describe, it, expect } from "vitest";
import { buildActogramRows, buildTauRows } from "../actogramData";
import type { SleepRecord } from "../../api/types";

function makeRecord(start: string, end: string, id = 1): SleepRecord {
  const startTime = new Date(start);
  const endTime = new Date(end);
  const durationMs = endTime.getTime() - startTime.getTime();
  const dateStr = start.slice(0, 10);
  return {
    logId: id,
    dateOfSleep: dateStr,
    startTime,
    endTime,
    durationMs,
    durationHours: durationMs / 3_600_000,
    efficiency: 90,
    minutesAsleep: Math.round(durationMs / 60_000 * 0.9),
    minutesAwake: Math.round(durationMs / 60_000 * 0.1),
    isMainSleep: true,
    sleepScore: 0.8,
  };
}

describe("buildActogramRows", () => {
  it("returns empty for empty input", () => {
    expect(buildActogramRows([])).toEqual([]);
  });

  it("returns rows in newest-first order", () => {
    const records = [
      makeRecord("2024-01-01T23:00:00", "2024-01-02T07:00:00", 1),
      makeRecord("2024-01-03T23:00:00", "2024-01-04T07:00:00", 2),
    ];
    const rows = buildActogramRows(records);
    // Newest first: last date should be first row
    expect(rows[0]!.date > rows[rows.length - 1]!.date).toBe(true);
  });

  it("splits midnight-crossing sleep into two rows", () => {
    const records = [makeRecord("2024-01-01T23:00:00", "2024-01-02T07:00:00", 1)];
    const rows = buildActogramRows(records);

    // Should have rows for both Jan 1 and Jan 2
    const jan1 = rows.find(r => r.date === "2024-01-01");
    const jan2 = rows.find(r => r.date === "2024-01-02");

    expect(jan1).toBeDefined();
    expect(jan2).toBeDefined();
    expect(jan1!.blocks.length).toBe(1);
    expect(jan2!.blocks.length).toBe(1);

    // Jan 1 block: 23:00-24:00 → startHour=23, endHour=24
    expect(jan1!.blocks[0]!.startHour).toBeCloseTo(23, 1);
    expect(jan1!.blocks[0]!.endHour).toBeCloseTo(24, 1);

    // Jan 2 block: 00:00-07:00 → startHour=0, endHour=7
    expect(jan2!.blocks[0]!.startHour).toBeCloseTo(0, 1);
    expect(jan2!.blocks[0]!.endHour).toBeCloseTo(7, 1);
  });

  it("adds extra forecast days", () => {
    const records = [makeRecord("2024-01-01T23:00:00", "2024-01-02T07:00:00", 1)];
    const noExtra = buildActogramRows(records, 0);
    const withExtra = buildActogramRows(records, 5);
    expect(withExtra.length).toBe(noExtra.length + 5);
  });

  it("handles single-day sleep (no midnight crossing)", () => {
    const records = [makeRecord("2024-01-01T13:00:00", "2024-01-01T14:30:00", 1)];
    const rows = buildActogramRows(records);
    const jan1 = rows.find(r => r.date === "2024-01-01");
    expect(jan1).toBeDefined();
    expect(jan1!.blocks.length).toBe(1);
    expect(jan1!.blocks[0]!.startHour).toBeCloseTo(13, 1);
    expect(jan1!.blocks[0]!.endHour).toBeCloseTo(14.5, 1);
  });
});

describe("buildTauRows", () => {
  it("returns empty for empty input", () => {
    expect(buildTauRows([], 24)).toEqual([]);
  });

  it("creates rows with correct width", () => {
    const records = [
      makeRecord("2024-01-01T23:00:00", "2024-01-02T07:00:00", 1),
      makeRecord("2024-01-02T23:30:00", "2024-01-03T07:30:00", 2),
    ];
    const rows = buildTauRows(records, 25);
    // Each row spans 25 hours
    for (const row of rows) {
      for (const block of row.blocks) {
        expect(block.endHour).toBeLessThanOrEqual(25);
        expect(block.startHour).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("rows are newest-first", () => {
    const records = [
      makeRecord("2024-01-01T23:00:00", "2024-01-02T07:00:00", 1),
      makeRecord("2024-01-03T23:00:00", "2024-01-04T07:00:00", 2),
    ];
    const rows = buildTauRows(records, 24.5);
    // Newest first means startMs should decrease
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.startMs!).toBeLessThan(rows[i - 1]!.startMs!);
    }
  });
});
