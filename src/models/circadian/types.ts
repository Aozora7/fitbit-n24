// Type definitions for circadian period estimation (algorithm-independent)
import type { SleepRecord } from "../../api/types";

export interface CircadianDay {
    date: string;
    nightStartHour: number;
    nightEndHour: number;
    confidenceScore: number;
    confidence: "high" | "medium" | "low";
    localTau: number;
    localDrift: number;
    anchorSleep?: SleepRecord;
    isForecast: boolean;
    isGap: boolean;
}

export interface CircadianAnalysis {
    globalTau: number;
    globalDailyDrift: number;
    days: CircadianDay[];
    algorithmId: string;
    tau: number;
    dailyDrift: number;
    rSquared: number;
}

export const GAP_THRESHOLD_DAYS = 14;
