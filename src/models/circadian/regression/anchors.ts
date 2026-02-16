// Anchor classification, midpoint computation, and median spacing
import type { SleepRecord } from "../../../api/types";
import type { Anchor, AnchorCandidate, AnchorTier } from "./types";

export function classifyAnchor(record: SleepRecord): AnchorCandidate | null {
    const quality = record.sleepScore;
    const dur = record.durationHours;

    let tier: AnchorTier;
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

    return { record, quality, tier, weight };
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
