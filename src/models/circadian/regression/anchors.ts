// Anchor weight computation, midpoint computation, and median spacing
import type { SleepRecord } from "../../../api/types";
import type { Anchor } from "./types";

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

export function computeMedianSpacing(anchors: Anchor[]): number {
    if (anchors.length < 2) return 7;
    const spacings: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
        spacings.push(anchors[i]!.dayNumber - anchors[i - 1]!.dayNumber);
    }
    spacings.sort((a, b) => a - b);
    return spacings[Math.floor(spacings.length / 2)]!;
}
