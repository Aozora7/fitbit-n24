import { useState, useCallback } from "react";
import type { SleepRecord, RawSleepRecordV12 } from "../api/types";
import { calculateSleepScore } from "../models/calculateSleepScore";
import { loadLocalData } from "./loadLocalData";

interface SleepDataState {
    records: SleepRecord[];
    loading: boolean;
    error: string | null;
    /** Replace current records with new ones (from API fetch or import) */
    setRecords: (records: SleepRecord[]) => void;
    /** Append records to existing data (for progressive loading) */
    appendRecords: (newRecords: SleepRecord[]) => void;
    /** Load records from one or more JSON files, merging all into one dataset */
    importFromFiles: (files: File[]) => Promise<void>;
}

/** Parse a v1.2 raw record into a SleepRecord */
function parseV12(raw: RawSleepRecordV12): SleepRecord {
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

/** Sort records oldest-first and deduplicate by logId */
function sortAndDedup(records: SleepRecord[]): SleepRecord[] {
    records.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const seen = new Set<number>();
    return records.filter((r) => {
        if (seen.has(r.logId)) return false;
        seen.add(r.logId);
        return true;
    });
}

export function useSleepData(): SleepDataState {
    const [records, setRecordsRaw] = useState<SleepRecord[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const setRecords = useCallback((recs: SleepRecord[]) => {
        setRecordsRaw(sortAndDedup(recs));
        setError(null);
    }, []);

    const appendRecords = useCallback((newRecords: SleepRecord[]) => {
        setRecordsRaw((prev) => sortAndDedup([...prev, ...newRecords]));
        setError(null);
    }, []);

    const importFromFiles = useCallback(async (files: File[]) => {
        if (files.length === 0) return;

        try {
            setLoading(true);
            const allRecords: SleepRecord[] = [];

            for (const file of files) {
                if (!file) continue;
                const blobUrl = URL.createObjectURL(file);
                try {
                    const recs = await loadLocalData(blobUrl);
                    allRecords.push(...recs);
                } finally {
                    URL.revokeObjectURL(blobUrl);
                }
            }

            setRecordsRaw(sortAndDedup(allRecords));
            setError(null);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Import failed");
        } finally {
            setLoading(false);
        }
    }, []);

    return { records, loading, error, setRecords, appendRecords, importFromFiles };
}

/**
 * Convert raw v1.2 API records to SleepRecord[] for use with setRecords.
 */
export function parseApiRecords(raws: RawSleepRecordV12[]): SleepRecord[] {
    return sortAndDedup(raws.map(parseV12));
}
