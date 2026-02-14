// Anchor classification, midpoint computation, segment splitting, and median spacing
import type { SleepRecord } from "../../api/types";
import type { Anchor, AnchorCandidate, AnchorTier } from "./types";
import { GAP_THRESHOLD_DAYS } from "./types";

// ─── Segment splitting ────────────────────────────────────────────

/** Split sorted records into independent segments at data gaps > GAP_THRESHOLD_DAYS */
export function splitIntoSegments(records: SleepRecord[]): SleepRecord[][] {
    if (records.length === 0) return [];
    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const segments: SleepRecord[][] = [[sorted[0]!]];
    let latestDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    for (let i = 1; i < sorted.length; i++) {
        const currDateMs = new Date(sorted[i]!.dateOfSleep + "T00:00:00").getTime();
        const gapDays = Math.round((currDateMs - latestDateMs) / 86_400_000);
        if (gapDays > GAP_THRESHOLD_DAYS) {
            segments.push([sorted[i]!]);
        } else {
            segments[segments.length - 1]!.push(sorted[i]!);
        }
        latestDateMs = Math.max(latestDateMs, currDateMs);
    }
    return segments;
}

// ─── Anchor classification ─────────────────────────────────────────

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

    // Naps still contribute data but can't dominate regression or unwrapping
    if (!record.isMainSleep) {
        weight *= 0.15;
    }

    return { record, quality, tier, weight };
}

// ─── Midpoint computation ──────────────────────────────────────────

/** Compute midpoint as absolute hours from a fixed epoch (firstDateMs) */
export function sleepMidpointHour(record: SleepRecord, firstDateMs: number): number {
    const midMs = record.startTime.getTime() + record.durationMs / 2;
    return (midMs - firstDateMs) / 3_600_000;
}

// ─── Helpers ───────────────────────────────────────────────────────

export function computeMedianSpacing(anchors: Anchor[]): number {
    if (anchors.length < 2) return 7;
    const spacings: number[] = [];
    for (let i = 1; i < anchors.length; i++) {
        spacings.push(anchors[i]!.dayNumber - anchors[i - 1]!.dayNumber);
    }
    spacings.sort((a, b) => a - b);
    return spacings[Math.floor(spacings.length / 2)]!;
}
