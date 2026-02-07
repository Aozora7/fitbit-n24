import { useState, useCallback, useRef } from "react";
import { useSleepData, parseApiRecords } from "./useSleepData";
import { fetchAllSleepRecords, fetchNewSleepRecords } from "../api/sleepApi";
import { getCachedRecords, getLatestDateOfSleep, putRecords, clearUserCache } from "./sleepCache";
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
    /** Start fetching sleep records (loads cache first, then fetches only new data) */
    startFetch: (token: string, userId: string) => void;
    /** Abort the current fetch (keeps already-fetched data) */
    stopFetch: () => void;
    /** Trigger a JSON file import */
    importFromFile: (file: File) => void;
    /** Download all records as a JSON file */
    exportToFile: () => void;
    /** Clear the IndexedDB cache for a user and reset in-memory state */
    clearCache: (userId: string) => Promise<void>;
    /** Clear in-memory state only (e.g. on sign-out) */
    reset: () => void;
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
        async (token: string, userId: string) => {
            const abortController = new AbortController();
            fetchAbortRef.current = abortController;
            setFetching(true);
            setFetchProgress("Loading cached data...");

            // Track new records fetched from API (for writing to cache at the end)
            const newRawRecords: RawSleepRecordV12[] = [];

            try {
                // Phase 1: Load from IndexedDB cache
                const cachedRaw = await getCachedRecords(userId);
                if (cachedRaw.length > 0) {
                    rawRecordsRef.current = [...cachedRaw];
                    const parsed = parseApiRecords(cachedRaw);
                    setRecords(parsed);
                    setFetchProgress(`Loaded ${cachedRaw.length} cached records. Checking for new data...`);
                } else {
                    rawRecordsRef.current = [];
                    setRecords([]);
                    setFetchProgress("Starting...");
                }

                // Phase 2: Incremental or full fetch
                const latestDate = await getLatestDateOfSleep(userId);

                const onPageData = (pageRecords: RawSleepRecordV12[], totalSoFar: number, page: number) => {
                    rawRecordsRef.current.push(...pageRecords);
                    newRawRecords.push(...pageRecords);
                    const parsed = parseApiRecords(pageRecords);
                    appendRecords(parsed);
                    setFetchProgress(
                        latestDate
                            ? `Page ${page}: ${totalSoFar} new records...`
                            : `Page ${page}: ${totalSoFar} records...`
                    );
                };

                if (latestDate) {
                    await fetchNewSleepRecords(token, latestDate, onPageData, abortController.signal);
                } else {
                    await fetchAllSleepRecords(token, onPageData, abortController.signal);
                }

                // Phase 3: Final status
                if (newRawRecords.length > 0) {
                    setFetchProgress(`Done: ${rawRecordsRef.current.length} total records (${newRawRecords.length} new)`);
                } else if (cachedRaw.length > 0) {
                    setFetchProgress(`Up to date: ${rawRecordsRef.current.length} records`);
                } else {
                    setFetchProgress(`Done: ${rawRecordsRef.current.length} records loaded`);
                }
            } catch (err: unknown) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    setFetchProgress(`Stopped: ${rawRecordsRef.current.length} records kept`);
                } else {
                    setFetchProgress(`Error: ${err instanceof Error ? err.message : "Fetch failed"}`);
                }
            } finally {
                setFetching(false);
                fetchAbortRef.current = null;

                // Persist any newly fetched records to cache
                if (newRawRecords.length > 0) {
                    putRecords(userId, newRawRecords).catch(err =>
                        console.warn("[sleepCache] Failed to write new records:", err)
                    );
                }
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

    const clearCache = useCallback(async (userId: string) => {
        await clearUserCache(userId);
        rawRecordsRef.current = [];
        setRecords([]);
        setFetchProgress("");
    }, [setRecords]);

    const reset = useCallback(() => {
        rawRecordsRef.current = [];
        setRecords([]);
        setFetchProgress("");
    }, [setRecords]);

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
        clearCache,
        reset,
    };
}
