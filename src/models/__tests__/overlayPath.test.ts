import { describe, it, expect } from "vitest";
import { interpolateOverlay, unwrapMidpoint, unwrapMidpointForEditor, type OverlayControlPoint } from "../overlayPath";

describe("unwrapMidpoint", () => {
    it("no-op when already close", () => {
        expect(unwrapMidpoint(10, 11)).toBe(10);
    });

    it("wraps forward through midnight (23 → 1 means 25)", () => {
        expect(unwrapMidpoint(1, 23)).toBe(25);
    });

    it("wraps backward through midnight (1 → 23 means -1 ≡ 23)", () => {
        // ref=1, new=23 → should become -1 (nearest branch)
        expect(unwrapMidpoint(23, 1)).toBe(-1);
    });

    it("handles values already outside 0-24", () => {
        expect(unwrapMidpoint(49, 47)).toBe(49);
    });
});

describe("unwrapMidpointForEditor", () => {
    it("short gap: behaves like nearest-branch unwrap", () => {
        // 2 day gap — should use nearest branch like unwrapMidpoint
        expect(unwrapMidpointForEditor(1, 23, 2)).toBe(25);
    });

    it("long gap: prefers forward drift over nearest branch", () => {
        // Point A at hour 1, point B at hour 22, 37 days later
        // Nearest branch: -2 (drift = -0.08 h/day, backward)
        // Forward branch: 22 (drift = 0.57 h/day, plausible N24)
        expect(unwrapMidpointForEditor(22, 1, 37)).toBe(22);
    });

    it("long gap: keeps nearest branch when drift is already plausible", () => {
        // Point A at hour 10, point B at hour 14, 20 days later
        // Nearest branch: 14 (drift = 0.2 h/day, plausible)
        expect(unwrapMidpointForEditor(14, 10, 20)).toBe(14);
    });

    it("long gap backward in time: prefers forward drift direction", () => {
        // Point B at hour 22, point A at hour 1, -37 days (new point is earlier)
        // The earlier point should have a smaller unwrapped value
        // Nearest branch: unwrapMidpoint(1, 22) = 25. drift = (25-22)/(-37) = -0.08 (backward)
        // Alt branch: 25-24 = 1. drift = (1-22)/(-37) = 0.57 (forward)
        expect(unwrapMidpointForEditor(1, 22, -37)).toBe(1);
    });

    it("falls back to nearest branch when no branch gives plausible drift", () => {
        // Very short time gap but > 3 days — both branches give extreme drift
        // Point A at hour 1, point B at hour 13, 4 days later
        // Nearest: 13, drift = 3.0 h/day (> 2, too fast)
        // Alt: 13-24 = -11, drift = -3.0 h/day (negative)
        // Falls back to nearest
        expect(unwrapMidpointForEditor(13, 1, 4)).toBe(13);
    });
});

describe("interpolateOverlay", () => {
    it("returns empty for no control points", () => {
        expect(interpolateOverlay([], 8, "2024-01-01", "2024-01-05")).toEqual([]);
    });

    it("returns empty for reversed date range", () => {
        const cp: OverlayControlPoint[] = [{ date: "2024-01-03", midpointHour: 2 }];
        expect(interpolateOverlay(cp, 8, "2024-01-05", "2024-01-01")).toEqual([]);
    });

    it("single control point → only that date", () => {
        const cp: OverlayControlPoint[] = [{ date: "2024-01-03", midpointHour: 2 }];
        const result = interpolateOverlay(cp, 8, "2024-01-01", "2024-01-05");
        expect(result).toHaveLength(1);
        expect(result[0]!.date).toBe("2024-01-03");
        expect(result[0]!.nightStartHour).toBe(-2); // 2 - 4
        expect(result[0]!.nightEndHour).toBe(6); // 2 + 4
    });

    it("two control points → linear interpolation between them", () => {
        const cp: OverlayControlPoint[] = [
            { date: "2024-01-01", midpointHour: 0 },
            { date: "2024-01-05", midpointHour: 4 },
        ];
        const result = interpolateOverlay(cp, 8, "2024-01-01", "2024-01-05");
        expect(result).toHaveLength(5);
        // Day 0: mid=0, Day 1: mid=1, Day 2: mid=2, Day 3: mid=3, Day 4: mid=4
        expect(result[0]!.nightStartHour).toBe(-4);
        expect(result[0]!.nightEndHour).toBe(4);
        expect(result[2]!.nightStartHour).toBe(-2); // mid=2, 2-4=-2
        expect(result[2]!.nightEndHour).toBe(6); // 2+4=6
        expect(result[4]!.nightStartHour).toBe(0); // mid=4, 4-4=0
        expect(result[4]!.nightEndHour).toBe(8);
    });

    it("no extrapolation beyond control points", () => {
        const cp: OverlayControlPoint[] = [
            { date: "2024-01-03", midpointHour: 10 },
            { date: "2024-01-05", midpointHour: 12 },
        ];
        const result = interpolateOverlay(cp, 6, "2024-01-01", "2024-01-07");
        // Only 3 days: Jan 3, 4, 5 (between first and last control point)
        expect(result).toHaveLength(3);
        expect(result[0]!.date).toBe("2024-01-03");
        expect(result[0]!.nightStartHour).toBe(7); // 10 - 3
        expect(result[2]!.date).toBe("2024-01-05");
        expect(result[2]!.nightStartHour).toBe(9); // 12 - 3
    });

    it("handles unwrapped midpoints crossing midnight", () => {
        const cp: OverlayControlPoint[] = [
            { date: "2024-01-01", midpointHour: 23 },
            { date: "2024-01-03", midpointHour: 25 }, // unwrapped: 1am next cycle
        ];
        const result = interpolateOverlay(cp, 8, "2024-01-01", "2024-01-03");
        expect(result).toHaveLength(3);
        // Day 0: mid=23, Day 1: mid=24, Day 2: mid=25
        expect(result[1]!.nightStartHour).toBe(20); // 24 - 4
        expect(result[1]!.nightEndHour).toBe(28); // 24 + 4
    });

    it("three control points → two linear segments", () => {
        const cp: OverlayControlPoint[] = [
            { date: "2024-01-01", midpointHour: 0 },
            { date: "2024-01-03", midpointHour: 4 },
            { date: "2024-01-05", midpointHour: 4 }, // flat segment
        ];
        const result = interpolateOverlay(cp, 8, "2024-01-01", "2024-01-05");
        // Segment 1: Jan 1 (mid=0) → Jan 3 (mid=4), slope = 2/day
        // Segment 2: Jan 3 (mid=4) → Jan 5 (mid=4), flat
        expect(result[0]!.nightStartHour).toBe(-4); // mid=0
        expect(result[1]!.nightStartHour).toBe(-2); // mid=2
        expect(result[2]!.nightStartHour).toBe(0); // mid=4
        expect(result[3]!.nightStartHour).toBe(0); // mid=4 (flat)
        expect(result[4]!.nightStartHour).toBe(0); // mid=4 (flat)
    });

    it("control points provided out of order are sorted", () => {
        const cp: OverlayControlPoint[] = [
            { date: "2024-01-05", midpointHour: 4 },
            { date: "2024-01-01", midpointHour: 0 },
        ];
        const result = interpolateOverlay(cp, 8, "2024-01-01", "2024-01-05");
        // Should behave same as sorted
        expect(result[2]!.nightStartHour).toBe(-2); // mid=2 at midpoint
    });
});
