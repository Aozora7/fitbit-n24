import type { CSFAnchor } from "./types";
import type { SleepRecord } from "../../../api/types";

export function classifyAnchor(record: SleepRecord): {
    tier: "A" | "B" | "C";
    weight: number;
} | null {
    const quality = record.sleepScore;
    const dur = record.durationHours;

    let tier: "A" | "B" | "C";
    let baseWeight: number;

    if (dur >= 7 && quality >= 0.75) {
        tier = "A";
        baseWeight = 1.0;
    } else if (dur >= 5 && quality >= 0.6) {
        tier = "B";
        baseWeight = 0.4;
    } else if (dur >= 4 && quality >= 0.4) {
        tier = "C";
        baseWeight = 0.1;
    } else {
        return null;
    }

    const durFactor = Math.min(1, (dur - 4) / 5);
    let weight = baseWeight * quality * durFactor;

    if (!record.isMainSleep) {
        weight *= 0.15;
    }

    return { tier, weight };
}

export function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

export function prepareAnchors(records: SleepRecord[], globalFirstDateMs: number): CSFAnchor[] {
    const candidates: { record: SleepRecord; tier: "A" | "B" | "C"; weight: number }[] = [];

    for (const record of records) {
        const result = classifyAnchor(record);
        if (result) {
            candidates.push({ record, ...result });
        }
    }

    const abDates = new Set(candidates.filter((c) => c.tier !== "C").map((c) => c.record.dateOfSleep));
    let maxGapAB = 0;
    const sortedABDates = [...abDates].sort();
    for (let i = 1; i < sortedABDates.length; i++) {
        const gap = Math.round(
            (new Date(sortedABDates[i]! + "T00:00:00").getTime() -
                new Date(sortedABDates[i - 1]! + "T00:00:00").getTime()) /
                86_400_000
        );
        maxGapAB = Math.max(maxGapAB, gap);
    }

    const activeCandidates = maxGapAB > 14 ? candidates : candidates.filter((c) => c.tier !== "C");

    const bestByDate = new Map<string, CSFAnchor>();
    for (const c of activeCandidates) {
        const existing = bestByDate.get(c.record.dateOfSleep);
        if (!existing || c.weight > existing.weight) {
            bestByDate.set(c.record.dateOfSleep, {
                dayNumber: Math.round(
                    (new Date(c.record.dateOfSleep + "T00:00:00").getTime() - globalFirstDateMs) / 86_400_000
                ),
                midpointHour: sleepMidpointHour(c.record, globalFirstDateMs),
                weight: c.weight,
                tier: c.tier,
                record: c.record,
            });
        }
    }

    return [...bestByDate.values()].sort((a, b) => a.dayNumber - b.dayNumber);
}
