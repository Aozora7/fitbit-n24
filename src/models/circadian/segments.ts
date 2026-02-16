// Segment splitting for data with gaps (algorithm-agnostic)
import type { SleepRecord } from "../../api/types";
import { GAP_THRESHOLD_DAYS } from "./types";

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
