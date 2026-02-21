import { expect } from "vitest";
import type { CircadianDay } from "../../circadian/types";

// Hard drift limits (hours/day)
const DRIFT_MIN = -1.5;
const DRIFT_MAX = 3.0;

// Penalty zone edges (1h inside hard limits)
const PENALTY_LOWER_START = -0.5; // penalty zone: [DRIFT_MIN, PENALTY_LOWER_START]
const PENALTY_UPPER_START = 2.0; // penalty zone: [PENALTY_UPPER_START, DRIFT_MAX]

export interface DriftPenaltyResult {
    /** Total penalty score (0 = perfect, higher = worse). Grows superlinearly with consecutive days in penalty zone. */
    totalPenalty: number;
    /** Number of days with non-zero penalty */
    penaltyDays: number;
    /** Longest consecutive run of penalty days */
    maxConsecutivePenaltyDays: number;
    /** Fraction of data days in penalty zones */
    penaltyFraction: number;
}

/**
 * Compute drift penalty for prolonged periods near hard limits.
 *
 * Penalty zones: drift in [-1.5, -0.5] or [2.0, 3.0] (within 1h of hard limits).
 * Per-day penalty: linear interpolation (0 at zone inner edge, 1.0 at hard limit).
 * Consecutive multiplier: day penalty × streak length for superlinear growth.
 */
export function computeDriftPenalty(
    days: ReadonlyArray<Pick<CircadianDay, "localDrift" | "isForecast" | "isGap">>
): DriftPenaltyResult {
    const dataDays = days.filter((d) => !d.isForecast && !d.isGap);
    let totalPenalty = 0;
    let penaltyDays = 0;
    let maxConsecutive = 0;
    let currentConsecutive = 0;

    for (const day of dataDays) {
        const drift = day.localDrift;
        let dayPenalty = 0;

        if (drift >= DRIFT_MIN && drift < PENALTY_LOWER_START) {
            // Near lower limit: linear 0→1 as drift goes from -0.5 to -1.5
            dayPenalty =
                (Math.abs(drift) - Math.abs(PENALTY_LOWER_START)) /
                (Math.abs(DRIFT_MIN) - Math.abs(PENALTY_LOWER_START));
        } else if (drift > PENALTY_UPPER_START && drift <= DRIFT_MAX) {
            // Near upper limit: linear 0→1 as drift goes from 2.0 to 3.0
            dayPenalty = (drift - PENALTY_UPPER_START) / (DRIFT_MAX - PENALTY_UPPER_START);
        }

        if (dayPenalty > 0) {
            penaltyDays++;
            currentConsecutive++;
            totalPenalty += dayPenalty * currentConsecutive;
            maxConsecutive = Math.max(maxConsecutive, currentConsecutive);
        } else {
            currentConsecutive = 0;
        }
    }

    return {
        totalPenalty,
        penaltyDays,
        maxConsecutivePenaltyDays: maxConsecutive,
        penaltyFraction: dataDays.length > 0 ? penaltyDays / dataDays.length : 0,
    };
}

/**
 * Assert hard drift limits on every non-forecast, non-gap day.
 * localDrift must be in [-1.5, +3.0] h/day.
 */
export function assertHardDriftLimits(
    days: ReadonlyArray<Pick<CircadianDay, "localDrift" | "isForecast" | "isGap" | "date">>
): void {
    for (const day of days) {
        if (day.isForecast || day.isGap) continue;
        expect(
            day.localDrift,
            `localDrift=${day.localDrift.toFixed(3)} on ${day.date} exceeds hard minimum (-1.5)`
        ).toBeGreaterThanOrEqual(DRIFT_MIN);
        expect(
            day.localDrift,
            `localDrift=${day.localDrift.toFixed(3)} on ${day.date} exceeds hard maximum (3.0)`
        ).toBeLessThanOrEqual(DRIFT_MAX);
    }
}
