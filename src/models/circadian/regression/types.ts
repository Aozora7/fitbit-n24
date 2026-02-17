// Regression algorithm-specific types and constants
import type { SleepRecord } from "../../../api/types";
import type { CircadianAnalysis, CircadianDay } from "../types";

export interface AnchorPoint {
    dayNumber: number;
    midpointHour: number;
    weight: number;
    date: string;
}

export interface RegressionAnalysis extends CircadianAnalysis {
    anchors: AnchorPoint[];
    medianResidualHours: number;
    anchorCount: number;
}

export interface Anchor {
    dayNumber: number;
    midpointHour: number;
    weight: number;
    record: SleepRecord;
    date: string;
}

export interface SegmentResult {
    days: CircadianDay[];
    anchors: AnchorPoint[];
    anchorCount: number;
    residuals: number[];
    segFirstDay: number;
    segLastDay: number;
}

export const WINDOW_HALF = 21;
export const MAX_WINDOW_HALF = 60;
export const MIN_ANCHORS_PER_WINDOW = 6;
export const GAUSSIAN_SIGMA = 14;
export const OUTLIER_THRESHOLD_HOURS = 8;
export const SEED_HALF = 21;
export const MIN_SEED_ANCHORS = 4;
export const EXPANSION_LOOKBACK_DAYS = 30;
export const REGULARIZATION_HALF = 60;
export const SMOOTH_HALF = 7;
export const SMOOTH_SIGMA = 3;
export const SMOOTH_JUMP_THRESH = 2;
