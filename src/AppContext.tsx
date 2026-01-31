import { createContext, useContext, useState, useMemo, useCallback, useRef, type ReactNode } from "react";
import { useAuth } from "./auth/useAuth";
import { useFitbitData, type FitbitDataState } from "./data/useFitbitData";
import { analyzeCircadian, type CircadianAnalysis } from "./models/circadian";
import type { ColorMode } from "./components/Actogram/useActogramRenderer";
import type { SleepRecord } from "./api/types";

/** Max canvas height in pixels (conservative cross-browser limit) */
const MAX_CANVAS_HEIGHT = 32_768;
/** Fixed margins in the actogram renderer (top + bottom) */
const ACTOGRAM_MARGINS = 50;

// ── Context shape ───────────────────────────────────────────────

export interface AppState {
    // Data
    data: FitbitDataState;
    auth: { token: string | null; loading: boolean; error: string | null; signIn: () => Promise<void>; signOut: () => void };
    hasClientId: boolean;

    // Filtered / derived data
    filteredRecords: SleepRecord[];
    circadianAnalysis: CircadianAnalysis;
    forecastDays: number;
    totalDays: number;
    firstDateStr: string;
    daySpan: number;
    cumulativeShiftDays: number;
    avgSleepPerDay: number;

    // Visualization settings
    doublePlot: boolean;
    setDoublePlot: (v: boolean) => void;
    showCircadian: boolean;
    setShowCircadian: (v: boolean) => void;
    colorMode: ColorMode;
    setColorMode: (v: ColorMode) => void;
    rowHeight: number;
    setRowHeight: (v: number) => void;
    maxRowHeight: number;
    effectiveRowHeight: number;

    // Date filter
    filterStart: number;
    filterEnd: number;
    handleFilterChange: (start: number, end: number) => void;

    // Actions
    handleFetch: () => void;
}

const AppContext = createContext<AppState | null>(null);

// ── Provider ────────────────────────────────────────────────────

export function AppProvider({ children }: { children: ReactNode }) {
    const data = useFitbitData();
    const auth = useAuth();

    // Visualization settings
    const [doublePlot, setDoublePlot] = useState(false);
    const [rowHeight, setRowHeight] = useState(5);
    const [showCircadian, setShowCircadian] = useState(true);
    const [colorMode, setColorMode] = useState<ColorMode>("stages");

    // Date range filter state
    const [filterStart, setFilterStart] = useState(0);
    const [filterEnd, setFilterEnd] = useState(0);

    // ── Derived values ──────────────────────────────────────────

    const totalDays = useMemo(() => {
        if (data.records.length === 0) return 0;
        const first = data.records[0]!.startTime.getTime();
        const last = data.records[data.records.length - 1]!.endTime.getTime();
        return Math.ceil((last - first) / 86_400_000) + 1;
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
        const baseDay = base.getTime();
        const rangeStartMs = baseDay + filterStart * 86_400_000;
        const rangeEndMs = baseDay + filterEnd * 86_400_000;

        return data.records.filter(r => r.endTime.getTime() > rangeStartMs && r.startTime.getTime() < rangeEndMs);
    }, [data.records, filterStart, filterEnd, totalDays]);

    const handleFilterChange = useCallback((start: number, end: number) => {
        setFilterStart(start);
        setFilterEnd(end);
    }, []);

    const forecastDays = useMemo(() => {
        if (filteredRecords.length === 0) return 0;
        const diffMs = Date.now() - filteredRecords[filteredRecords.length - 1]!.endTime.getTime();
        return diffMs / 86_400_000 < 2 ? 1 : 0;
    }, [filteredRecords]);

    const circadianAnalysis = useMemo(() => analyzeCircadian(filteredRecords, forecastDays), [filteredRecords, forecastDays]);

    const daySpan = useMemo(() => {
        if (filteredRecords.length === 0) return 0;
        const first = filteredRecords[0]!.startTime.getTime();
        const last = filteredRecords[filteredRecords.length - 1]!.endTime.getTime();
        return Math.ceil((last - first) / 86_400_000) + 1;
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
        return filteredRecords.reduce((sum, r) => sum + r.durationHours, 0) / daySpan;
    }, [filteredRecords, daySpan]);

    const handleFetch = useCallback(() => {
        if (auth.token) data.startFetch(auth.token);
    }, [auth.token, data.startFetch]);

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
            totalDays,
            firstDateStr,
            daySpan,
            cumulativeShiftDays,
            avgSleepPerDay,
            doublePlot,
            setDoublePlot,
            showCircadian,
            setShowCircadian,
            colorMode,
            setColorMode,
            rowHeight,
            setRowHeight,
            maxRowHeight,
            effectiveRowHeight,
            filterStart,
            filterEnd,
            handleFilterChange,
            handleFetch,
        }),
        [
            data,
            auth,
            hasClientId,
            filteredRecords,
            circadianAnalysis,
            forecastDays,
            totalDays,
            firstDateStr,
            daySpan,
            cumulativeShiftDays,
            avgSleepPerDay,
            doublePlot,
            showCircadian,
            colorMode,
            rowHeight,
            maxRowHeight,
            effectiveRowHeight,
            filterStart,
            filterEnd,
            handleFilterChange,
            handleFetch,
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
