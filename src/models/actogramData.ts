import type { SleepRecord } from "../api/types";

/** A single sleep block positioned within a row's time window */
export interface SleepBlock {
    /** Fractional hour start within the row (0 to rowWidth) */
    startHour: number;
    /** Fractional hour end within the row (0 to rowWidth) */
    endHour: number;
    /** Original record reference (carries stageData) */
    record: SleepRecord;
}

/** One row in the actogram */
export interface ActogramRow {
    /** Label string — "YYYY-MM-DD" for calendar mode, "YYYY-MM-DD HH:mm" for tau mode */
    date: string;
    /** Sleep blocks clipped to this row's time window */
    blocks: SleepBlock[];
    /** Absolute start time of this row in ms (present in tau mode) */
    startMs?: number;
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
 * @param sortDirection - "newest" for newest-first (default), "oldest" for oldest-first
 */
export function buildActogramRows(
    records: SleepRecord[],
    extraDays = 0,
    sortDirection: "newest" | "oldest" = "newest"
): ActogramRow[] {
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

    // Apply sort direction
    if (sortDirection === "newest") rows.reverse();

    return rows;
}

/**
 * Build actogram rows with a custom row width (tau) in hours.
 * Each row spans `tau` hours, starting from the first record's midnight.
 * When tau=24 the result is equivalent to buildActogramRows (but row 0
 * starts at the first record's local midnight rather than calendar-day aligned).
 *
 * @param sortDirection - "newest" for newest-first (default), "oldest" for oldest-first
 */
export function buildTauRows(
    records: SleepRecord[],
    tau: number,
    extraDays = 0,
    sortDirection: "newest" | "oldest" = "newest"
): ActogramRow[] {
    if (records.length === 0) return [];

    const tauMs = tau * 3_600_000;

    // Start from midnight of the first record's day
    const originMs = localMidnight(records[0]!.startTime).getTime();
    const lastDate = new Date(records[records.length - 1]!.endTime);
    lastDate.setDate(lastDate.getDate() + extraDays);
    const lastMs = lastDate.getTime();

    const rowCount = Math.ceil((lastMs - originMs) / tauMs);
    const rows: ActogramRow[] = [];

    for (let i = 0; i < rowCount; i++) {
        const rowStartMs = originMs + i * tauMs;
        const d = new Date(rowStartMs);
        const dateStr = toLocalDateStr(d);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        // Only append time if row doesn't start at midnight
        const label = d.getHours() === 0 && d.getMinutes() === 0 ? dateStr : `${dateStr} ${hh}:${mm}`;

        rows.push({ date: label, blocks: [], startMs: rowStartMs });
    }

    // Place each sleep record into overlapping rows
    for (const record of records) {
        const sleepStartMs = record.startTime.getTime();
        const sleepEndMs = record.endTime.getTime();

        // Find the first row that could overlap
        const firstRow = Math.max(0, Math.floor((sleepStartMs - originMs) / tauMs));
        const lastRow = Math.min(rows.length - 1, Math.floor((sleepEndMs - originMs) / tauMs));

        for (let i = firstRow; i <= lastRow; i++) {
            const rowStartMs = originMs + i * tauMs;
            const rowEndMs = rowStartMs + tauMs;

            const blockStartMs = Math.max(sleepStartMs, rowStartMs);
            const blockEndMs = Math.min(sleepEndMs, rowEndMs);

            if (blockEndMs > blockStartMs) {
                rows[i]!.blocks.push({
                    startHour: (blockStartMs - rowStartMs) / 3_600_000,
                    endHour: (blockEndMs - rowStartMs) / 3_600_000,
                    record,
                });
            }
        }
    }

    // Apply sort direction
    if (sortDirection === "newest") rows.reverse();

    return rows;
}
