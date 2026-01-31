import type { SleepRecord } from "../api/types";

/** A single sleep block positioned within a 24h window */
export interface SleepBlock {
  /** Fractional hour start within the day (0-24) */
  startHour: number;
  /** Fractional hour end within the day (0-24) */
  endHour: number;
  /** Original record reference (carries minuteData or stageData) */
  record: SleepRecord;
}

/** One row in the actogram, representing a single calendar day */
export interface ActogramRow {
  /** Calendar date string "YYYY-MM-DD" */
  date: string;
  /** Sleep blocks that overlap this calendar day, clipped to [0, 24] */
  blocks: SleepBlock[];
}

/** Format a local Date as "YYYY-MM-DD" without UTC conversion */
function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Get local midnight for a date */
function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

/**
 * Build actogram row data from sleep records.
 * Each calendar day in the range gets a row with any overlapping sleep blocks
 * clipped to the [0, 24) hour window of that day.
 *
 * @param extraDays - Number of empty forecast days to append after the data range
 */
export function buildActogramRows(records: SleepRecord[], extraDays = 0): ActogramRow[] {
  if (records.length === 0) return [];

  // Find date range
  const firstDate = records[0]!.startTime;
  const lastDate = records[records.length - 1]!.endTime;

  // Generate all calendar days in range (using local dates), plus forecast days
  const rows: ActogramRow[] = [];
  const current = localMidnight(firstDate);
  const end = new Date(lastDate);
  end.setHours(23, 59, 59, 999);
  end.setDate(end.getDate() + extraDays);

  while (current <= end) {
    rows.push({ date: toLocalDateStr(current), blocks: [] });
    current.setDate(current.getDate() + 1);
  }

  // Map date string to row index for fast lookup
  const dateIndex = new Map<string, number>();
  rows.forEach((row, i) => dateIndex.set(row.date, i));

  // Place each sleep record into overlapping day rows
  for (const record of records) {
    const sleepStart = new Date(record.startTime);
    const sleepEnd = new Date(record.endTime);
    const dayStart = localMidnight(sleepStart);

    while (dayStart < sleepEnd) {
      const dateStr = toLocalDateStr(dayStart);
      const rowIdx = dateIndex.get(dateStr);

      if (rowIdx !== undefined) {
        const dayMidnight = dayStart.getTime();
        const dayEndMs = dayMidnight + 24 * 3_600_000;

        // Clip sleep to this day's window
        const blockStart = Math.max(sleepStart.getTime(), dayMidnight);
        const blockEnd = Math.min(sleepEnd.getTime(), dayEndMs);

        if (blockEnd > blockStart) {
          const startHour = (blockStart - dayMidnight) / 3_600_000;
          const endHour = (blockEnd - dayMidnight) / 3_600_000;

          rows[rowIdx]!.blocks.push({
            startHour,
            endHour,
            record,
          });
        }
      }

      dayStart.setDate(dayStart.getDate() + 1);
    }
  }

  // Newest first
  rows.reverse();

  return rows;
}
