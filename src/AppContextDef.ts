import { createContext } from "react";
import type { FitbitDataState } from "./data/useFitbitData";
import type { CircadianAnalysis } from "./models/circadian";
import type { ColorMode } from "./components/Actogram/useActogramRenderer";
import type { SleepRecord } from "./api/types";
import type { OverlayControlPoint, OverlayDay } from "./models/overlayPath";

// ── Schedule types ───────────────────────────────────────────────

export interface ScheduleEntry {
    id: string;
    startTime: string; // "HH:mm"
    endTime: string; // "HH:mm"
    days: boolean[]; // [Mon, Tue, Wed, Thu, Fri, Sat, Sun]
}

// ── Context shape ────────────────────────────────────────────────

export interface AppState {
    // Data
    data: FitbitDataState;
    auth: {
        token: string | null;
        userId: string | null;
        loading: boolean;
        error: string | null;
        signIn: () => Promise<void>;
        signOut: () => void;
    };
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

    // Overlay editor
    overlayEditMode: boolean;
    setOverlayEditMode: (v: boolean) => void;
    overlayControlPoints: OverlayControlPoint[];
    setOverlayControlPoints: (
        v: OverlayControlPoint[] | ((prev: OverlayControlPoint[]) => OverlayControlPoint[]),
    ) => void;
    overlaySleepWindow: number;
    setOverlaySleepWindow: (v: number) => void;
    manualOverlayDays: OverlayDay[];

    // Actions
    handleFetch: () => void;
}

export const AppContext = createContext<AppState | null>(null);
