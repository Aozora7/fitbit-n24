// Kalman filter algorithm-specific types and constants
import type { CircadianAnalysis } from "../types";

export interface KalmanAnalysis extends CircadianAnalysis {
    gatedOutlierCount: number;
    observationCount: number;
    avgInnovation: number;
}

/** State vector: [phase (hours from first midnight), drift (hours/day)] */
export type State = [number, number];

/** 2x2 symmetric covariance: [p00, p01, p11] where p01=p10 */
export type Cov = [number, number, number];

/** Per-day observation extracted from sleep records */
export interface Observation {
    dayNumber: number;
    midpointHour: number;
    R: number;
    record: import("../../../api/types").SleepRecord;
}

// --- Algorithm constants ---

/** Process noise for phase (h²) — true circadian phase jitter ~0.1h/day */
export const Q_PHASE = 0.01;

/** Process noise for drift (h²/day²) — drift changes ~0.01 h/day per day */
export const Q_DRIFT = 0.0001;

/** Base measurement noise (h²) — night-to-night sleep timing variability ~2h */
export const R_BASE = 1.5;

/** Mahalanobis distance threshold for outlier gating */
export const GATE_THRESHOLD = 3.5;

/** Number of days to use for initialization linear fit */
export const INIT_WINDOW = 7;

/** Default drift prior for very sparse initialization (typical N24) */
export const DEFAULT_DRIFT_PRIOR = 0.7;

/** Initial phase uncertainty (h²) */
export const INIT_P_PHASE = 4.0;

/** Initial drift uncertainty (h²/day²) */
export const INIT_P_DRIFT = 0.25;
