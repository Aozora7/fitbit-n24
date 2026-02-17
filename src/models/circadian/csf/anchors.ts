import type { CSFAnchor } from "./types";
import type { SleepRecord } from "../../../api/types";

export function computeAnchorWeight(record: SleepRecord): number | null {
    const quality = record.sleepScore;
    const dur = record.durationHours;

    const durFactor = Math.min(1, Math.max(0, (dur - 4) / 3));
    const weight = quality * durFactor;

    if (weight < 0.05) return null;

    return record.isMainSleep ? weight : weight * 0.15;
}

export function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

export function prepareAnchors(records: SleepRecord[], globalFirstDateMs: number): CSFAnchor[] {
    const candidates: { record: SleepRecord; weight: number }[] = [];

    for (const record of records) {
        const weight = computeAnchorWeight(record);
        if (weight === null) continue;
        candidates.push({ record, weight });
    }

    const bestByDate = new Map<string, CSFAnchor>();
    for (const c of candidates) {
        const existing = bestByDate.get(c.record.dateOfSleep);
        if (!existing || c.weight > existing.weight) {
            bestByDate.set(c.record.dateOfSleep, {
                dayNumber: Math.round(
                    (new Date(c.record.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
                ),
                midpointHour: sleepMidpointHour(c.record, globalFirstDateMs),
                weight: c.weight,
                record: c.record,
            });
        }
    }

    return [...bestByDate.values()].sort((a, b) => a.dayNumber - b.dayNumber);
}
