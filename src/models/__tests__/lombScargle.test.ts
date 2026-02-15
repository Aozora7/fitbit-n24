import { describe, it, expect } from "vitest";
import { computeLombScargle } from "../lombScargle";
import type { AnchorPoint } from "../circadian";

function makeSyntheticAnchors(tau: number, days: number, noise = 0): AnchorPoint[] {
    const anchors: AnchorPoint[] = [];
    const drift = tau - 24;

    for (let d = 0; d < days; d++) {
        const mid = 3 + d * drift + noise * Math.sin(d * 0.1); // deterministic "noise"
        anchors.push({
            dayNumber: d,
            midpointHour: mid,
            weight: 1.0,
            tier: "A",
            date: `2024-01-${String(d + 1).padStart(2, "0")}`,
        });
    }

    return anchors;
}

describe("computeLombScargle", () => {
    it("finds peak near true period for tau=24.5", () => {
        const anchors = makeSyntheticAnchors(24.5, 200);
        const result = computeLombScargle(anchors);
        expect(Math.abs(result.peakPeriod - 24.5)).toBeLessThan(0.2);
    });

    it("finds peak near 24.0 for tau=24.0", () => {
        const anchors = makeSyntheticAnchors(24.0, 200);
        const result = computeLombScargle(anchors);
        expect(Math.abs(result.peakPeriod - 24.0)).toBeLessThan(0.2);
    });

    it("significance threshold is positive", () => {
        const anchors = makeSyntheticAnchors(24.5, 100);
        const result = computeLombScargle(anchors);
        expect(result.significanceThreshold).toBeGreaterThan(0);
    });

    it("trimmed range includes 24h", () => {
        const anchors = makeSyntheticAnchors(24.5, 100);
        const result = computeLombScargle(anchors);
        const periods = result.trimmedPoints.map((p) => p.period);
        expect(Math.min(...periods)).toBeLessThanOrEqual(24.0);
        expect(Math.max(...periods)).toBeGreaterThanOrEqual(24.0);
    });

    it("returns empty for <3 anchors", () => {
        const result = computeLombScargle([
            { dayNumber: 0, midpointHour: 3, weight: 1, tier: "A", date: "2024-01-01" },
            { dayNumber: 1, midpointHour: 3.5, weight: 1, tier: "A", date: "2024-01-02" },
        ]);
        expect(result.points).toHaveLength(0);
        expect(result.peakPower).toBe(0);
    });

    it("power24h is populated", () => {
        const anchors = makeSyntheticAnchors(24.0, 100);
        const result = computeLombScargle(anchors);
        expect(result.power24h).toBeGreaterThan(0);
    });
});
