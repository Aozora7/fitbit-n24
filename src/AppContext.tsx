import { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef, type ReactNode } from "react";
import { useAuth } from "./auth/useAuth";
import { useFitbitData, type FitbitDataState } from "./data/useFitbitData";
import { analyzeCircadian, type CircadianAnalysis } from "./models/circadian";
import type { ColorMode } from "./components/Actogram/useActogramRenderer";
import type { SleepRecord } from "./api/types";

// ── Schedule types ──────────────────────────────────────────────

export interface ScheduleEntry {
    id: string;
    startTime: string; // "HH:mm"
    endTime: string; // "HH:mm"
    days: boolean[]; // [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
}

/** Max canvas height in pixels (conservative cross-browser limit) */
const MAX_CANVAS_HEIGHT = 32_768;
/** Fixed margins in the actogram renderer (top + bottom) */
const ACTOGRAM_MARGINS = 50;

// ── Context shape ───────────────────────────────────────────────

export interface AppState {
    // Data
    data: FitbitDataState;
    auth: { token: string | null; userId: string | null; loading: boolean; error: string | null; signIn: () => Promise<void>; signOut: () => void };
    hasClientId: boolean;

    // Filtered / derived data
    filteredRecords: SleepRecord[];
    circadianAnalysis: CircadianAnalysis;
    forecastDays: number;
    setForecastDays: (v: number) => void;
    forecastDisabled: boolean;
    totalDays: number;
    firstDateStr: string;
    daySpan: number;
    cumulativeShiftDays: number;
    avgSleepPerDay: number;
    avgTimeInBedPerDay: number;

    // Visualization settings
    doublePlot: boolean;
    setDoublePlot: (v: boolean) => void;
    showCircadian: boolean;
    setShowCircadian: (v: boolean) => void;
    showPeriodogram: boolean;
    setShowPeriodogram: (v: boolean) => void;
    colorMode: ColorMode;
    setColorMode: (v: ColorMode) => void;
    tauHours: number;
    setTauHours: (v: number) => void;
    rowHeight: number;
    setRowHeight: (v: number) => void;
    maxRowHeight: number;
    effectiveRowHeight: number;

    // Date filter
    filterStart: number;
    filterEnd: number;
    handleFilterChange: (start: number, end: number) => void;

    // Schedule overlay
    showSchedule: boolean;
    setShowSchedule: (v: boolean) => void;
    showScheduleEditor: boolean;
    setShowScheduleEditor: (v: boolean) => void;
    scheduleEntries: ScheduleEntry[];
    setScheduleEntries: (v: ScheduleEntry[] | ((prev: ScheduleEntry[]) => ScheduleEntry[])) => void;

    // Actions
    handleFetch: () => void;
}

const AppContext = createContext<AppState | null>(null);

// ── Persisted state helper ───────────────────────────────────────

function usePersistedState<T>(key: string, defaultValue: T) {
    const [value, setValue] = useState<T>(() => {
        try {
            const stored = localStorage.getItem(key);
            return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
        } catch {
            return defaultValue;
        }
    });
    const setAndPersist = useCallback(
        (v: T | ((prev: T) => T)) => {
            setValue(prev => {
                const next = typeof v === "function" ? (v as (prev: T) => T)(prev) : v;
                try {
                    localStorage.setItem(key, JSON.stringify(next));
                } catch {
                    /* quota exceeded */
                }
                return next;
            });
        },
        [key]
    );
    return [value, setAndPersist] as const;
}

// ── Provider ────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
    const data = useFitbitData();
    const auth = useAuth();

    // Visualization settings (persisted to localStorage)
    const [doublePlot, setDoublePlot] = usePersistedState("viz.doublePlot", false);
    const [rowHeight, setRowHeight] = usePersistedState("viz.rowHeight", 5);
    const [showCircadian, setShowCircadian] = usePersistedState("viz.showCircadian", true);
    const [showPeriodogram, setShowPeriodogram] = usePersistedState("viz.showPeriodogram", true);
    const [colorMode, setColorMode] = usePersistedState<ColorMode>("viz.colorMode", "stages");
    const [tauHours, setTauHours] = usePersistedState("viz.tauHours", 24);

    // Schedule overlay (persisted to localStorage)
    const [showSchedule, setShowSchedule] = usePersistedState("viz.showSchedule", false);
    const [showScheduleEditor, setShowScheduleEditor] = useState(false);
    const [scheduleEntries, setScheduleEntries] = usePersistedState<ScheduleEntry[]>("viz.scheduleEntries", []);

    useEffect(() => {
        if (showSchedule && !showScheduleEditor && !scheduleEntries.length) {
            setShowScheduleEditor(true);
        }
    }, [showSchedule]);

    // Auto-import dev data file if present (development convenience)
    const autoImportedRef = useRef(false);
    useEffect(() => {
        if (!autoImportedRef.current && data.records.length === 0 && !data.loading) {
            autoImportedRef.current = true;
            fetch("/dev-data/auto-import.json")
                .then(async res => {
                    if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
                        const blob = await res.blob();
                        const file = new File([blob], "auto-import.json", { type: "application/json" });
                        await data.importFromFile(file);
                        console.log("[DevMode] Auto-imported dev-data/auto-import.json");
                    }
                })
                .catch(() => {
                    // File doesn't exist, ignore silently
                });
        }
    }, [data.records.length, data.loading, data.importFromFile]);

    // Auto-fetch after OAuth login (token appears and no data loaded yet)
    const autoFetchedRef = useRef(false);
    useEffect(() => {
        if (auth.token && auth.userId && data.records.length === 0 && !data.fetching && !autoFetchedRef.current) {
            autoFetchedRef.current = true;
            data.startFetch(auth.token, auth.userId);
        }
    }, [auth.token, auth.userId, data.records.length, data.fetching, data.startFetch]);

    // Date range filter state
    const [filterStart, setFilterStart] = useState(0);
    const [filterEnd, setFilterEnd] = useState(0);

    // ── Derived values ──────────────────────────────────────────

    const totalDays = useMemo(() => {
        if (data.records.length === 0) return 0;
        const first = data.records[0]!.startTime.getTime();
        const last = data.records[data.records.length - 1]!.endTime.getTime();
        return Math.round((last - first) / 86_400_000) + 1;
    }, [data.records]);

    const firstDateStr = useMemo(() => {
        if (data.records.length === 0) return "";
        const d = data.records[0]!.startTime;
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }, [data.records]);

    // Keep filter end in sync with totalDays during progressive fetch
    const prevTotalDaysRef = useRef(0);
    if (totalDays !== prevTotalDaysRef.current) {
        const wasFullRange = prevTotalDaysRef.current === 0 || (filterStart === 0 && filterEnd >= prevTotalDaysRef.current);
        prevTotalDaysRef.current = totalDays;
        if (wasFullRange) {
            setFilterStart(0);
            setFilterEnd(totalDays);
        }
    }

    const filteredRecords = useMemo(() => {
        if (data.records.length === 0 || totalDays === 0) return data.records;
        if (filterStart === 0 && filterEnd >= totalDays) return data.records;

        const base = new Date(data.records[0]!.startTime);
        base.setHours(0, 0, 0, 0);
        const rangeStart = new Date(base);
        rangeStart.setDate(rangeStart.getDate() + filterStart);
        const rangeStartMs = rangeStart.getTime();
        const rangeEnd = new Date(base);
        rangeEnd.setDate(rangeEnd.getDate() + filterEnd);
        const rangeEndMs = rangeEnd.getTime();

        return data.records.filter(r => r.endTime.getTime() > rangeStartMs && r.startTime.getTime() < rangeEndMs);
    }, [data.records, filterStart, filterEnd, totalDays]);

    const handleFilterChange = useCallback((start: number, end: number) => {
        setFilterStart(start);
        setFilterEnd(end);
    }, []);

    const [forecastDays, setForecastDays] = usePersistedState<number>("viz.forecastDays", 0);

    const forecastDisabled = filterEnd < totalDays || !showCircadian;
    const effectiveForecastDays = forecastDisabled ? 0 : forecastDays;

    const circadianAnalysis = useMemo(() => analyzeCircadian(filteredRecords, effectiveForecastDays), [filteredRecords, effectiveForecastDays]);

    const daySpan = useMemo(() => {
        if (filteredRecords.length === 0) return 0;
        const first = filteredRecords[0]!.startTime.getTime();
        const last = filteredRecords[filteredRecords.length - 1]!.endTime.getTime();
        return Math.round((last - first) / 86_400_000) + 1;
    }, [filteredRecords]);

    const maxRowHeight = useMemo(() => {
        if (daySpan === 0) return 32;
        return Math.min(32, Math.floor((MAX_CANVAS_HEIGHT - ACTOGRAM_MARGINS) / daySpan));
    }, [daySpan]);

    const effectiveRowHeight = Math.min(rowHeight, maxRowHeight);

    const cumulativeShiftDays = useMemo(() => {
        if (daySpan === 0 || circadianAnalysis.globalDailyDrift === 0) return 0;
        return (circadianAnalysis.globalDailyDrift * daySpan) / 24;
    }, [circadianAnalysis.globalDailyDrift, daySpan]);

    const avgSleepPerDay = useMemo(() => {
        if (filteredRecords.length === 0 || daySpan === 0) return 0;
        return filteredRecords.reduce((sum, r) => sum + r.minutesAsleep / 60, 0) / daySpan;
    }, [filteredRecords, daySpan]);

    const avgTimeInBedPerDay = useMemo(() => {
        if (filteredRecords.length === 0 || daySpan === 0) return 0;
        return filteredRecords.reduce((sum, r) => sum + r.durationHours, 0) / daySpan;
    }, [filteredRecords, daySpan]);

    const handleFetch = useCallback(() => {
        if (auth.token && auth.userId) data.startFetch(auth.token, auth.userId);
    }, [auth.token, auth.userId, data.startFetch]);

    const hasClientId = !!import.meta.env.VITE_FITBIT_CLIENT_ID;

    // ── Context value ───────────────────────────────────────────

    const value: AppState = useMemo(
        () => ({
            data,
            auth,
            hasClientId,
            filteredRecords,
            circadianAnalysis,
            forecastDays,
            setForecastDays,
            forecastDisabled,
            totalDays,
            firstDateStr,
            daySpan,
            cumulativeShiftDays,
            avgSleepPerDay,
            avgTimeInBedPerDay,
            doublePlot,
            setDoublePlot,
            showCircadian,
            setShowCircadian,
            showPeriodogram,
            setShowPeriodogram,
            colorMode,
            setColorMode,
            tauHours,
            setTauHours,
            rowHeight,
            setRowHeight,
            maxRowHeight,
            effectiveRowHeight,
            filterStart,
            filterEnd,
            handleFilterChange,
            showSchedule,
            setShowSchedule,
            showScheduleEditor,
            setShowScheduleEditor,
            scheduleEntries,
            setScheduleEntries,
            handleFetch
        }),
        [
            data,
            auth,
            hasClientId,
            filteredRecords,
            circadianAnalysis,
            forecastDays,
            forecastDisabled,
            totalDays,
            firstDateStr,
            daySpan,
            cumulativeShiftDays,
            avgSleepPerDay,
            avgTimeInBedPerDay,
            doublePlot,
            showCircadian,
            showPeriodogram,
            colorMode,
            tauHours,
            rowHeight,
            maxRowHeight,
            effectiveRowHeight,
            filterStart,
            filterEnd,
            handleFilterChange,
            showSchedule,
            showScheduleEditor,
            scheduleEntries,
            handleFetch
        ]
    );

    return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ── Consumer hook ───────────────────────────────────────────────

export function useAppContext(): AppState {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error("useAppContext must be used inside <AppProvider>");
    return ctx;
}
