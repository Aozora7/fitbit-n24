import { useState, useCallback, useRef } from "react";
import { useSleepData, parseApiRecords } from "./useSleepData";
import { fetchAllSleepRecords } from "../api/sleepApi";
import type { RawSleepRecordV12, SleepRecord } from "../api/types";

export interface FitbitDataState {
    /** All parsed sleep records (unfiltered) */
    records: SleepRecord[];
    /** Whether initial data is loading */
    loading: boolean;
    /** Data-level error message */
    error: string | null;
    /** Whether a fetch is in progress */
    fetching: boolean;
    /** Human-readable fetch progress string */
    fetchProgress: string;
    /** Start fetching all sleep records from the Fitbit API */
    startFetch: (token: string) => void;
    /** Abort the current fetch (keeps already-fetched data) */
    stopFetch: () => void;
    /** Trigger a JSON file import */
    importFromFile: (file: File) => void;
    /** Download all records as a JSON file */
    exportToFile: () => void;
}

/**
 * Encapsulates all data-fetching, import, and export logic.
 * Returns a stable interface that UI components can consume
 * without knowing about raw API records, abort controllers, etc.
 */
export function useFitbitData(): FitbitDataState {
    const { records, loading, error, setRecords, appendRecords, importFromFile } = useSleepData();

    const [fetching, setFetching] = useState(false);
    const [fetchProgress, setFetchProgress] = useState("");

    // Keep raw API records for clean round-trip export
    const rawRecordsRef = useRef<RawSleepRecordV12[]>([]);
    const fetchAbortRef = useRef<AbortController | null>(null);

    const startFetch = useCallback(
        async (token: string) => {
            const abortController = new AbortController();
            fetchAbortRef.current = abortController;
            setFetching(true);
            setFetchProgress("Starting...");
            rawRecordsRef.current = [];
            setRecords([]);
            try {
                await fetchAllSleepRecords(
                    token,
                    (pageRecords, totalSoFar, page) => {
                        rawRecordsRef.current.push(...pageRecords);
                        const parsed = parseApiRecords(pageRecords);
                        appendRecords(parsed);
                        setFetchProgress(`Page ${page}: ${totalSoFar} records...`);
                    },
                    abortController.signal
                );
                setFetchProgress(`Done: ${rawRecordsRef.current.length} records loaded`);
            } catch (err: unknown) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    setFetchProgress(`Stopped: ${rawRecordsRef.current.length} records kept`);
                } else {
                    setFetchProgress(`Error: ${err instanceof Error ? err.message : "Fetch failed"}`);
                }
            } finally {
                setFetching(false);
                fetchAbortRef.current = null;
            }
        },
        [setRecords, appendRecords]
    );

    const stopFetch = useCallback(() => {
        fetchAbortRef.current?.abort();
    }, []);

    const exportToFile = useCallback(() => {
        const exportData = rawRecordsRef.current.length > 0 ? { sleep: rawRecordsRef.current } : { sleep: records };
        const json = JSON.stringify(exportData, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `fitbit-sleep-export-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [records]);

    return {
        records,
        loading,
        error,
        fetching,
        fetchProgress,
        startFetch,
        stopFetch,
        importFromFile,
        exportToFile,
    };
}
