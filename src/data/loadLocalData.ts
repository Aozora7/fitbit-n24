import type {
  RawSleepRecordV12,
  SleepRecord,
} from "../api/types";
import { calculateSleepScore } from "../models/calculateSleepScore";

function parseV12Record(raw: RawSleepRecordV12): SleepRecord {
  const record: SleepRecord = {
    logId: typeof raw.logId === "number" ? raw.logId : Number(raw.logId),
    dateOfSleep: raw.dateOfSleep,
    startTime: new Date(raw.startTime),
    endTime: new Date(raw.endTime),
    durationMs: raw.duration,
    durationHours: raw.duration / 3_600_000,
    efficiency: raw.efficiency,
    minutesAsleep: raw.minutesAsleep,
    minutesAwake: raw.minutesAwake,
    isMainSleep: raw.isMainSleep,
    sleepScore: calculateSleepScore(raw),
  };

  if (raw.levels) {
    // v1.2 "stages" type has deep/light/rem/wake summary;
    // v1.2 "classic" type has asleep/restless/awake instead — no stage data
    const s = raw.levels.summary;
    if (s && "deep" in s && s.deep && "light" in s && s.light && "rem" in s && s.rem && "wake" in s && s.wake) {
      record.stages = {
        deep: s.deep.minutes,
        light: s.light.minutes,
        rem: s.rem.minutes,
        wake: s.wake.minutes,
      };
    }
    if (raw.levels.data) {
      record.stageData = raw.levels.data;
    }
  }

  return record;
}

/**
 * Re-hydrate a record from our own export format (SleepRecord serialized to JSON).
 * startTime/endTime are ISO strings that need to become Date objects.
 */
function parseExportedRecord(raw: Record<string, unknown>): SleepRecord {
  return {
    logId: raw.logId as number,
    dateOfSleep: raw.dateOfSleep as string,
    startTime: new Date(raw.startTime as string),
    endTime: new Date(raw.endTime as string),
    durationMs: raw.durationMs as number,
    durationHours: raw.durationHours as number,
    efficiency: raw.efficiency as number,
    minutesAsleep: raw.minutesAsleep as number,
    minutesAwake: raw.minutesAwake as number,
    isMainSleep: (raw.isMainSleep as boolean) ?? true,
    sleepScore: (raw.sleepScore as number) ?? 0,
    stages: raw.stages as SleepRecord["stages"],
    stageData: raw.stageData as SleepRecord["stageData"],
  };
}

/**
 * Detect whether a raw record is our internal export or v1.2 format and parse accordingly.
 */
function parseAnyRecord(raw: Record<string, unknown>): SleepRecord {
  // Our own exported format uses "durationMs" instead of "duration"
  if ("durationMs" in raw) {
    return parseExportedRecord(raw);
  }
  if ("levels" in raw || "type" in raw) {
    return parseV12Record(raw as unknown as RawSleepRecordV12);
  }
  throw new Error("Unrecognized sleep record format: expected v1.2 (stages) data");
}

/**
 * Load sleep data from a local JSON file. Handles multiple formats:
 * - v1.2 single-page: { sleep: [...], pagination: {...} }
 * - v1.2 multi-page: [ { sleep: [...], pagination: {...} }, ... ]
 * - Flat array of records: [ { dateOfSleep, ... }, ... ]
 */
export async function loadLocalData(url: string): Promise<SleepRecord[]> {
  const response = await fetch(url);
  const data: unknown = await response.json();

  let rawRecords: Record<string, unknown>[];

  if (Array.isArray(data)) {
    if (data.length === 0) return [];

    // Check if it's an array of pages or an array of individual records
    const first = data[0] as Record<string, unknown>;
    if ("sleep" in first && Array.isArray(first.sleep)) {
      // Array of pages: [ { sleep: [...] }, ... ]
      rawRecords = data.flatMap(
        (page: Record<string, unknown>) =>
          (page.sleep as Record<string, unknown>[]) ?? [],
      );
    } else {
      // Flat array of records
      rawRecords = data;
    }
  } else if (
    typeof data === "object" &&
    data !== null &&
    "sleep" in (data as Record<string, unknown>)
  ) {
    // Single page: { sleep: [...], pagination: {...} }
    rawRecords = (data as Record<string, unknown>).sleep as Record<
      string,
      unknown
    >[];
  } else {
    throw new Error("Unrecognized sleep data format");
  }

  const allRecords = rawRecords.map(parseAnyRecord);

  // Sort by start time ascending (oldest first)
  allRecords.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  // Deduplicate by logId
  const seen = new Set<number>();
  return allRecords.filter((r) => {
    if (seen.has(r.logId)) return false;
    seen.add(r.logId);
    return true;
  });
}
