// ── Manual overlay path: types + interpolation ─────────────────────

/** A user-placed control point for the manual overlay */
export interface OverlayControlPoint {
    /** ISO date string "YYYY-MM-DD" */
    date: string;
    /** Midpoint hour, unwrapped (can be <0 or >24 to avoid phase-wrap ambiguity) */
    midpointHour: number;
}

/** A single day's interpolated overlay result */
export interface OverlayDay {
    date: string;
    nightStartHour: number;
    nightEndHour: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Days between two "YYYY-MM-DD" strings (positive if b > a) */
function daysBetween(a: string, b: string): number {
    const da = new Date(a + "T00:00:00");
    const db = new Date(b + "T00:00:00");
    return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/** Add N days to a "YYYY-MM-DD" string */
function addDays(date: string, n: number): string {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

/**
 * Phase-unwrap a new midpoint relative to a reference, snapping to the
 * nearest branch (same heuristic as circadian/unwrap.ts pairwise unwrap).
 */
export function unwrapMidpoint(newMid: number, refMid: number): number {
    let m = newMid;
    while (m - refMid > 12) m -= 24;
    while (refMid - m > 12) m += 24;
    return m;
}

/**
 * Drift-aware phase unwrap for the overlay editor.
 *
 * For points close in time (≤3 days), uses nearest-branch like `unwrapMidpoint`.
 * For larger gaps, prefers the branch that produces a forward drift rate
 * in a plausible range (0–2 h/day), consistent with N24 circadian drift.
 * This lets two points spanning many days represent continuous forward
 * drift through multiple 24h wraps, without needing intermediate points.
 */
export function unwrapMidpointForEditor(newMid: number, refMid: number, dayGap: number): number {
    if (Math.abs(dayGap) <= 3) {
        return unwrapMidpoint(newMid, refMid);
    }

    // Nearest branch
    let m = newMid;
    while (m - refMid > 12) m -= 24;
    while (refMid - m > 12) m += 24;

    const drift = (m - refMid) / dayGap;

    // Forward drift at a plausible rate — keep it
    if (drift >= 0 && drift <= 2) return m;

    // Try the adjacent branch in the forward direction
    const sign = dayGap > 0 ? 1 : -1;
    const mAlt = drift < 0 ? m + sign * 24 : m - sign * 24;
    const driftAlt = (mAlt - refMid) / dayGap;

    if (driftAlt >= 0 && driftAlt <= 2) return mAlt;

    // Neither branch plausible — fall back to nearest
    return m;
}

// ── Main interpolation ─────────────────────────────────────────────

/**
 * Interpolate control points into per-day overlay values.
 *
 * - Piecewise linear between consecutive control points
 * - Flat extrapolation beyond first/last point
 * - Control point midpoints are stored unwrapped; output preserves unwrapped values
 */
export function interpolateOverlay(
    controlPoints: OverlayControlPoint[],
    sleepWindowHours: number,
    startDate: string,
    endDate: string
): OverlayDay[] {
    if (controlPoints.length === 0) return [];

    // Sort by date
    const sorted = [...controlPoints].sort((a, b) => daysBetween(b.date, a.date));

    const totalDays = daysBetween(startDate, endDate);
    if (totalDays < 0) return [];

    const result: OverlayDay[] = [];
    const halfWindow = sleepWindowHours / 2;

    for (let i = 0; i <= totalDays; i++) {
        const date = addDays(startDate, i);
        const dayNum = i; // days from startDate

        // Find interpolated midpoint
        let mid: number;

        if (sorted.length === 1) {
            // Single point: only emit that exact date
            if (date !== sorted[0]!.date) continue;
            mid = sorted[0]!.midpointHour;
        } else {
            const cpDayNums = sorted.map((cp) => daysBetween(startDate, cp.date));

            // Outside control point range: skip (no extrapolation)
            if (dayNum < cpDayNums[0]! || dayNum > cpDayNums[cpDayNums.length - 1]!) {
                continue;
            }
            // Between two control points: linear interpolation
            else {
                // Find bracketing segment
                let segIdx = 0;
                for (let j = 0; j < cpDayNums.length - 1; j++) {
                    if (dayNum >= cpDayNums[j]! && dayNum <= cpDayNums[j + 1]!) {
                        segIdx = j;
                        break;
                    }
                }
                const d0 = cpDayNums[segIdx]!;
                const d1 = cpDayNums[segIdx + 1]!;
                const m0 = sorted[segIdx]!.midpointHour;
                const m1 = sorted[segIdx + 1]!.midpointHour;
                const t = d1 === d0 ? 0 : (dayNum - d0) / (d1 - d0);
                mid = m0 + t * (m1 - m0);
            }
        }

        result.push({
            date,
            nightStartHour: mid - halfWindow,
            nightEndHour: mid + halfWindow,
        });
    }

    return result;
}
