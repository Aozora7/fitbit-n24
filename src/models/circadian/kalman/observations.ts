// Extract per-day observations from sleep records
import type { SleepRecord } from "../../../api/types";
import type { Observation } from "./types";
import { R_BASE } from "./types";

/**
 * Compute sleep midpoint as hours from firstDateMs.
 */
function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

/**
 * Compute adaptive measurement noise for a sleep record.
 * Higher quality, longer duration, and main-sleep status → lower noise.
 */
function measurementNoise(record: SleepRecord): number {
    const quality = Math.max(0.1, record.sleepScore);
    const durFactor = Math.min(1, Math.max(0.1, (record.durationHours - 4) / 5));
    const mainFactor = record.isMainSleep ? 1.0 : 0.15;
    return R_BASE / (quality * durFactor * mainFactor);
}

/**
 * Extract one observation per day from sleep records.
 * For days with multiple records, pick the best main sleep (highest quality × duration).
 * Returns a Map keyed by dayNumber (days since first record's midnight).
 */
export function extractObservations(
    records: SleepRecord[],
    firstDateMs: number,
): Map<number, Observation> {
    const byDay = new Map<number, Observation>();

    for (const record of records) {
        // Skip records that are too short or too low quality to be useful
        if (record.durationHours < 2 || record.sleepScore < 0.1) continue;

        const midHour = sleepMidpointHour(record, firstDateMs);
        const dayNumber = Math.round(midHour / 24);
        const R = measurementNoise(record);

        const existing = byDay.get(dayNumber);
        if (!existing) {
            byDay.set(dayNumber, { dayNumber, midpointHour: midHour, R, record });
        } else {
            // Prefer main sleep; among main sleeps, prefer lower noise (better quality)
            const existingIsMain = existing.record.isMainSleep;
            const newIsMain = record.isMainSleep;

            if ((!existingIsMain && newIsMain) || (existingIsMain === newIsMain && R < existing.R)) {
                byDay.set(dayNumber, { dayNumber, midpointHour: midHour, R, record });
            }
        }
    }

    return byDay;
}

/**
 * Get the first date midnight timestamp from records.
 */
export function getFirstDateMs(records: SleepRecord[]): number {
    if (records.length === 0) return 0;
    const first = records[0]!.startTime;
    const d = new Date(first);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}
