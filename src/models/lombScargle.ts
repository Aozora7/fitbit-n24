import type { SleepRecord } from "../api/types";

export interface PeriodogramAnchor {
    dayNumber: number;
    midpointHour: number;
    weight: number;
}

export interface PeriodogramPoint {
    period: number; // trial period in hours
    power: number; // phase coherence (R²), 0 = uniform, 1 = perfectly concentrated
}

export interface PeriodogramResult {
    points: PeriodogramPoint[];
    trimmedPoints: PeriodogramPoint[];
    peakPeriod: number;
    peakPower: number;
    significanceThreshold: number;
    power24h: number;
}

export function buildPeriodogramAnchors(records: SleepRecord[]): PeriodogramAnchor[] {
    if (records.length === 0) return [];

    const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
    const firstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

    return sorted
        .filter((r) => r.isMainSleep && r.durationHours >= 4)
        .map((r) => {
            const dayNumber = Math.round((new Date(r.dateOfSleep + "T00:00:00").getTime() - firstDateMs) / 86_400_000);
            const midpointMs = (r.startTime.getTime() + r.endTime.getTime()) / 2;
            const midnightMs = new Date(r.dateOfSleep + "T00:00:00").getTime();
            const midpointHour = (midpointMs - midnightMs) / 3_600_000;
            const weight = r.sleepScore * Math.min(1, r.durationHours / 7);

            return { dayNumber, midpointHour, weight };
        });
}

// ─── Gaussian smoothing ────────────────────────────────────────────

/** 1-D Gaussian kernel convolution to suppress aliasing sidelobes. */
function gaussianSmooth(values: number[], sigma: number): number[] {
    const N = values.length;
    const out = new Array<number>(N);
    const radius = Math.ceil(sigma * 3);

    for (let i = 0; i < N; i++) {
        let sum = 0;
        let wSum = 0;
        for (let j = -radius; j <= radius; j++) {
            const idx = i + j;
            if (idx < 0 || idx >= N) continue;
            const w = Math.exp(-0.5 * (j / sigma) ** 2);
            sum += w * values[idx]!;
            wSum += w;
        }
        out[i] = sum / wSum;
    }

    return out;
}

// ─── Phase coherence periodogram (windowed weighted Rayleigh test) ─

/**
 * Compute a phase coherence periodogram from circadian anchor data
 * using a windowed weighted Rayleigh test.
 *
 * For each trial period P, anchor times are folded modulo P and mapped
 * to angles on the unit circle. The squared mean resultant length R²
 * measures how concentrated the folded phases are:
 *   R² ≈ 1  →  all anchors align at one phase  →  strong periodicity at P
 *   R² ≈ 0  →  anchors spread uniformly         →  no periodicity at P
 *
 * A sliding-window approach is used because the circadian period (tau)
 * is not constant — it varies with seasons, medication, and other factors.
 * Computing global R² across years of data with variable tau produces a
 * weak signal because phases drift relative to any single trial period.
 * Instead, R² is computed within overlapping windows (~120 days) where
 * tau is approximately stable, then averaged across all windows.
 *
 * The periodogram is computed over a wide range (16–48h) but the result
 * includes a `trimmedPoints` array auto-focused on the region of interest
 * (around significant peaks, always including 24h as reference).
 *
 * Reference: Batschelet (1981) "Circular Statistics in Biology"
 *            Refinetti (2016) "Circadian Physiology"
 */
export function computeLombScargle(
    anchors: PeriodogramAnchor[],
    options: {
        minPeriod?: number;
        maxPeriod?: number;
        step?: number;
    } = {}
): PeriodogramResult {
    const { minPeriod = 23.0, maxPeriod = 26.0, step = 0.01 } = options;

    const empty: PeriodogramResult = {
        points: [],
        trimmedPoints: [],
        peakPeriod: 24,
        peakPower: 0,
        significanceThreshold: 0,
        power24h: 0,
    };

    if (anchors.length < 3) return empty;

    // Precompute anchor times in hours and determine data span
    const times = anchors.map((a) => a.dayNumber * 24 + a.midpointHour);
    const weights = anchors.map((a) => a.weight);
    const dayNumbers = anchors.map((a) => a.dayNumber);
    const firstDay = dayNumbers[0]!;
    const lastDay = dayNumbers[dayNumbers.length - 1]!;
    const spanDays = lastDay - firstDay;

    // Sliding window parameters
    const WINDOW_DAYS = 120;
    const WINDOW_STEP = 30;
    const MIN_ANCHORS = 8;

    // Build windows
    interface Window {
        indices: number[];
        totalW: number;
    }

    const windows: Window[] = [];

    if (spanDays <= WINDOW_DAYS * 1.5) {
        const totalW = weights.reduce((s, w) => s + w, 0);
        windows.push({ indices: anchors.map((_, i) => i), totalW });
    } else {
        for (
            let center = firstDay + WINDOW_DAYS / 2;
            center <= lastDay - WINDOW_DAYS / 2 + WINDOW_STEP;
            center += WINDOW_STEP
        ) {
            const halfW = WINDOW_DAYS / 2;
            const indices: number[] = [];
            let totalW = 0;

            for (let i = 0; i < anchors.length; i++) {
                const dist = Math.abs(dayNumbers[i]! - center);
                if (dist <= halfW) {
                    indices.push(i);
                    totalW += weights[i]!;
                }
            }

            if (indices.length >= MIN_ANCHORS) {
                windows.push({ indices, totalW });
            }
        }
    }

    if (windows.length === 0) return empty;

    // Compute periodogram: average R² across windows
    const numTrials = Math.round((maxPeriod - minPeriod) / step) + 1;
    const periods = new Array<number>(numTrials);
    const avgPower = new Array<number>(numTrials).fill(0);

    // Effective sample size for significance (use median window size)
    const windowSizes = windows.map((w) => {
        let tw = 0;
        let tw2 = 0;
        for (const i of w.indices) {
            tw += weights[i]!;
            tw2 += weights[i]! * weights[i]!;
        }
        return (tw * tw) / tw2;
    });
    windowSizes.sort((a, b) => a - b);
    const medianNeff = windowSizes[Math.floor(windowSizes.length / 2)]!;

    for (let k = 0; k < numTrials; k++) {
        const period = minPeriod + k * step;
        periods[k] = period;

        let powerSum = 0;

        for (const win of windows) {
            let sumCos = 0;
            let sumSin = 0;

            for (const i of win.indices) {
                const phase = ((times[i]! % period) + period) % period;
                const theta = (2 * Math.PI * phase) / period;
                const w = weights[i]!;
                sumCos += w * Math.cos(theta);
                sumSin += w * Math.sin(theta);
            }

            const C = sumCos / win.totalW;
            const S = sumSin / win.totalW;
            powerSum += C * C + S * S;
        }

        avgPower[k] = powerSum / windows.length;
    }

    // Gaussian smooth to suppress aliasing sidelobes
    const smoothed = gaussianSmooth(avgPower, 3);

    // Build full result
    const points: PeriodogramPoint[] = [];
    let peakPower = 0;
    let peakPeriod = 24;
    let power24h = 0;

    for (let k = 0; k < numTrials; k++) {
        const period = periods[k]!;
        const power = smoothed[k]!;

        points.push({ period, power });

        if (power > peakPower) {
            peakPower = power;
            peakPeriod = period;
        }

        if (Math.abs(period - 24.0) < step / 2) {
            power24h = power;
        }
    }

    // Rayleigh significance threshold for p < 0.01 (R² scale)
    const significanceThreshold = -Math.log(0.01) / medianNeff;

    // ── Auto-trim to region of interest ─────────────────────────
    const PADDING = 0.25; // 15 minutes
    const MIN_DISPLAY_WIDTH = 2;

    // Find extent of significant peaks
    let sigMin = Infinity;
    let sigMax = -Infinity;
    for (const pt of points) {
        if (pt.power > significanceThreshold) {
            sigMin = Math.min(sigMin, pt.period);
            sigMax = Math.max(sigMax, pt.period);
        }
    }

    let displayMin: number;
    let displayMax: number;

    if (sigMin <= sigMax) {
        // Significant peaks found — trim around them
        displayMin = sigMin - PADDING;
        displayMax = sigMax + PADDING;
    } else {
        // No significant peaks — center on peak ±1h
        displayMin = peakPeriod - 1;
        displayMax = peakPeriod + 1;
    }

    // Always include 24h reference
    displayMin = Math.min(displayMin, 24 - PADDING);
    displayMax = Math.max(displayMax, 24 + PADDING);

    // Enforce minimum display width
    if (displayMax - displayMin < MIN_DISPLAY_WIDTH) {
        const center = (displayMin + displayMax) / 2;
        displayMin = center - MIN_DISPLAY_WIDTH / 2;
        displayMax = center + MIN_DISPLAY_WIDTH / 2;
    }

    // Clamp to computed range
    displayMin = Math.max(minPeriod, displayMin);
    displayMax = Math.min(maxPeriod, displayMax);

    const trimmedPoints = points.filter((p) => p.period >= displayMin && p.period <= displayMax);

    return {
        points,
        trimmedPoints,
        peakPeriod,
        peakPower,
        significanceThreshold,
        power24h,
    };
}
