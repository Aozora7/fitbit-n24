// Type definitions and constants for circadian period estimation
import type { SleepRecord } from "../../api/types";

// ─── Public interfaces ─────────────────────────────────────────────

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

export interface AnchorPoint {
    dayNumber: number;
    midpointHour: number; // unwrapped hours from first day's midnight
    weight: number;
    tier: "A" | "B" | "C";
    date: string;
}

export interface CircadianAnalysis {
    globalTau: number;
    globalDailyDrift: number;
    days: CircadianDay[];
    anchors: AnchorPoint[];
    medianResidualHours: number;
    anchorCount: number;
    anchorTierCounts: { A: number; B: number; C: number };
    // Legacy compat
    tau: number;
    dailyDrift: number;
    rSquared: number;
}

// ─── Anchor types ──────────────────────────────────────────────────

export type AnchorTier = "A" | "B" | "C";

export interface Anchor {
    dayNumber: number;
    midpointHour: number; // hours from first day's midnight (unwrapped)
    weight: number;
    tier: AnchorTier;
    record: SleepRecord;
    date: string;
}

export interface AnchorCandidate {
    record: SleepRecord;
    quality: number;
    tier: AnchorTier;
    weight: number;
}

export interface SegmentResult {
    days: CircadianDay[];
    anchors: AnchorPoint[];
    tierCounts: { A: number; B: number; C: number };
    anchorCount: number;
    residuals: number[];
    segFirstDay: number; // global day number of segment's first record
    segLastDay: number;  // global day number of segment's last data day
}

// ─── Constants ─────────────────────────────────────────────────────

export const WINDOW_HALF = 21; // 42-day window
export const MAX_WINDOW_HALF = 60; // expand to 120 days if sparse
export const MIN_ANCHORS_PER_WINDOW = 6;
export const GAUSSIAN_SIGMA = 14; // half-weight at 14 days from center
export const OUTLIER_THRESHOLD_HOURS = 8; // only catch genuine data errors
export const SEED_HALF = 21; // half-width of seed search window
export const MIN_SEED_ANCHORS = 4; // minimum anchors to evaluate a seed window
export const EXPANSION_LOOKBACK_DAYS = 30; // how far back to look when expanding
export const REGULARIZATION_HALF = 60; // half-width for regional slope fallback (120-day window; responsive to transitions)
export const SMOOTH_HALF = 7; // post-hoc smoothing: ±7 day neighborhood
export const SMOOTH_SIGMA = 3; // Gaussian sigma for smoothing weights
export const SMOOTH_JUMP_THRESH = 2; // only smooth days with >2h jump to neighbor
export const GAP_THRESHOLD_DAYS = 14; // suppress overlay when nearest sleep record is ≥14 days away
