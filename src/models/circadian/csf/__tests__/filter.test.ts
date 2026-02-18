import { describe, it, expect } from "vitest";
import {
    normalizeAngle,
    circularDiff,
    resolveAmbiguity,
    vonMisesUpdate,
    initializeState,
    predict,
    updatePrior,
    update,
    forwardPass,
    rtsSmoother,
} from "../filter";
import { DEFAULT_CONFIG, TAU_MIN, TAU_MAX } from "../types";
import type { CSFAnchor, CSFState, CSFConfig } from "../types";

describe("normalizeAngle", () => {
    it("normalizes positive values to [0, 24)", () => {
        expect(normalizeAngle(5)).toBe(5);
        expect(normalizeAngle(23)).toBe(23);
        expect(normalizeAngle(24)).toBe(0);
        expect(normalizeAngle(25)).toBe(1);
        expect(normalizeAngle(48)).toBe(0);
        expect(normalizeAngle(50)).toBe(2);
    });

    it("normalizes negative values to [0, 24)", () => {
        expect(normalizeAngle(-1)).toBe(23);
        expect(normalizeAngle(-2)).toBe(22);
        expect(normalizeAngle(-24)).toBe(0);
        expect(normalizeAngle(-25)).toBe(23);
    });

    it("handles fractional hours", () => {
        expect(normalizeAngle(23.5)).toBeCloseTo(23.5, 6);
        expect(normalizeAngle(-0.5)).toBeCloseTo(23.5, 6);
        expect(normalizeAngle(24.5)).toBeCloseTo(0.5, 6);
    });
});

describe("circularDiff", () => {
    it("returns small positive difference", () => {
        expect(circularDiff(3, 1)).toBeCloseTo(2, 6);
        expect(circularDiff(5, 3)).toBeCloseTo(2, 6);
    });

    it("returns small negative difference", () => {
        expect(circularDiff(1, 3)).toBeCloseTo(-2, 6);
        expect(circularDiff(3, 5)).toBeCloseTo(-2, 6);
    });

    it("wraps through midnight (shortest path)", () => {
        expect(circularDiff(1, 23)).toBeCloseTo(2, 6);
        expect(circularDiff(23, 1)).toBeCloseTo(-2, 6);
    });

    it("handles identical values", () => {
        expect(circularDiff(10, 10)).toBeCloseTo(0, 6);
        expect(circularDiff(0, 24)).toBeCloseTo(0, 6);
    });

    it("handles noon crossings", () => {
        expect(circularDiff(13, 11)).toBeCloseTo(2, 6);
        expect(circularDiff(11, 13)).toBeCloseTo(-2, 6);
    });
});

describe("resolveAmbiguity", () => {
    it("returns measurement unchanged when close to prediction", () => {
        expect(resolveAmbiguity(5, 6)).toBe(5);
        expect(resolveAmbiguity(5, 4)).toBe(5);
    });

    it("unwraps measurement forward through midnight", () => {
        expect(resolveAmbiguity(1, 23)).toBe(25);
        expect(resolveAmbiguity(2, 22)).toBe(26);
    });

    it("unwraps measurement backward through midnight", () => {
        expect(resolveAmbiguity(23, 1)).toBe(-1);
        expect(resolveAmbiguity(22, 2)).toBe(-2);
    });

    it("handles large phase offsets", () => {
        expect(resolveAmbiguity(5, 53)).toBe(53);
        expect(resolveAmbiguity(5, -43)).toBe(-43);
    });
});

describe("vonMisesUpdate", () => {
    it("returns measurement when prior kappa is zero", () => {
        const result = vonMisesUpdate(10, 0, 5, 1);
        expect(result.phase).toBeCloseTo(5, 4);
        expect(result.kappa).toBeCloseTo(1, 4);
    });

    it("returns prior when measurement kappa is zero", () => {
        const result = vonMisesUpdate(10, 1, 0, 0);
        expect(result.phase).toBeCloseTo(10, 4);
        expect(result.kappa).toBeCloseTo(1, 4);
    });

    it("averages phase when kappas are equal", () => {
        const result = vonMisesUpdate(0, 1, 2, 1);
        expect(result.phase).toBeCloseTo(1, 4);
        expect(result.kappa).toBeCloseTo(2 * Math.cos(Math.PI / 12), 4);
    });

    it("high measurement kappa pulls phase toward measurement", () => {
        const result = vonMisesUpdate(10, 1, 5, 10);
        expect(result.phase).toBeCloseTo(5.36, 1);
    });

    it("high prior kappa keeps phase near prior", () => {
        const result = vonMisesUpdate(10, 10, 5, 1);
        expect(result.phase).toBeCloseTo(9.64, 1);
    });

    it("increases certainty (kappa) with agreement", () => {
        const result = vonMisesUpdate(5, 1, 5, 1);
        expect(result.kappa).toBeCloseTo(2, 4);
    });
});

describe("initializeState", () => {
    const anchor: CSFAnchor = {
        dayNumber: 0,
        midpointHour: 3,
        weight: 1,
        record: {} as CSFAnchor["record"],
    };

    it("initializes phase from anchor", () => {
        const state = initializeState(anchor, DEFAULT_CONFIG);
        expect(state.phase).toBe(3);
    });

    it("initializes tau from config prior", () => {
        const state = initializeState(anchor, DEFAULT_CONFIG);
        expect(state.tau).toBe(DEFAULT_CONFIG.tauPrior);
    });

    it("initializes variance from config", () => {
        const state = initializeState(anchor, DEFAULT_CONFIG);
        expect(state.tauVar).toBe(DEFAULT_CONFIG.tauPriorVar);
        expect(state.phaseVar).toBe(1.0);
        expect(state.cov).toBe(0);
    });
});

describe("predict", () => {
    const state: CSFState = {
        phase: 10,
        tau: 25,
        phaseVar: 0.5,
        tauVar: 0.1,
        cov: 0.05,
    };

    it("advances phase by driftPerDay (tau - 24)", () => {
        const predicted = predict(state, DEFAULT_CONFIG);
        expect(predicted.phase).toBeCloseTo(10 + 1, 6);
    });

    it("handles tau = 24 (no drift)", () => {
        const noDriftState = { ...state, tau: 24 };
        const predicted = predict(noDriftState, DEFAULT_CONFIG);
        expect(predicted.phase).toBeCloseTo(10, 6);
    });

    it("handles negative drift (tau < 24)", () => {
        const negDriftState = { ...state, tau: 23 };
        const predicted = predict(negDriftState, DEFAULT_CONFIG);
        expect(predicted.phase).toBeCloseTo(9, 6);
    });

    it("preserves tau", () => {
        const predicted = predict(state, DEFAULT_CONFIG);
        expect(predicted.tau).toBe(25);
    });

    it("increases phase variance", () => {
        const predicted = predict(state, DEFAULT_CONFIG);
        expect(predicted.phaseVar).toBeGreaterThan(state.phaseVar);
    });

    it("increases tau variance", () => {
        const predicted = predict(state, DEFAULT_CONFIG);
        expect(predicted.tauVar).toBeGreaterThan(state.tauVar);
    });

    it("increases covariance", () => {
        const predicted = predict(state, DEFAULT_CONFIG);
        expect(predicted.cov).toBeGreaterThan(state.cov);
    });
});

describe("updatePrior", () => {
    const config: CSFConfig = {
        ...DEFAULT_CONFIG,
        tauPrior: 24.5,
        tauPriorNoise: { forward: 0.1, backward: 1.0, none: 5.0 },
    };

    it("pulls tau toward prior when drift is forward (tau > 24)", () => {
        const state: CSFState = {
            phase: 10,
            tau: 26,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };
        const updated = updatePrior(state, config);
        expect(updated.tau).toBeLessThan(26);
        expect(updated.tau).toBeGreaterThan(24.5);
    });

    it("uses backward noise when drift > prior drift", () => {
        const state: CSFState = {
            phase: 10,
            tau: 25.5,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };
        const updated = updatePrior(state, config);
        expect(updated.tau).toBeLessThan(state.tau);
    });

    it("clamps tau to valid range", () => {
        const extremeState: CSFState = {
            phase: 10,
            tau: 30,
            phaseVar: 0.5,
            tauVar: 10,
            cov: 0.05,
        };
        const updated = updatePrior(extremeState, config);
        expect(updated.tau).toBeLessThanOrEqual(TAU_MAX);
        expect(updated.tau).toBeGreaterThanOrEqual(TAU_MIN);
    });

    it("reduces tau variance", () => {
        const state: CSFState = {
            phase: 10,
            tau: 25,
            phaseVar: 0.5,
            tauVar: 0.5,
            cov: 0.05,
        };
        const updated = updatePrior(state, config);
        expect(updated.tauVar).toBeLessThan(state.tauVar);
    });
});

describe("update", () => {
    const config = DEFAULT_CONFIG;

    it("accepts measurement inside gate threshold", () => {
        const predicted: CSFState = {
            phase: 5,
            tau: 25,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };
        const anchor: CSFAnchor = {
            dayNumber: 1,
            midpointHour: 6,
            weight: 1,
            record: {} as CSFAnchor["record"],
        };

        const updated = update(predicted, anchor, config);

        expect(updated.phase).not.toBe(predicted.phase);
    });

    it("updatePrior modifies tau toward prior (changes state)", () => {
        const state: CSFState = {
            phase: 10,
            tau: 26,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };
        const updated = updatePrior(state, config);
        expect(updated.tau).not.toBe(state.tau);
    });

    it("higher weight anchors have more influence", () => {
        const predicted: CSFState = {
            phase: 5,
            tau: 25,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };

        const lowWeightAnchor: CSFAnchor = {
            dayNumber: 1,
            midpointHour: 10,
            weight: 0.1,
            record: {} as CSFAnchor["record"],
        };

        const highWeightAnchor: CSFAnchor = {
            dayNumber: 1,
            midpointHour: 10,
            weight: 1.0,
            record: {} as CSFAnchor["record"],
        };

        const updatedLow = update({ ...predicted }, lowWeightAnchor, config);
        const updatedHigh = update({ ...predicted }, highWeightAnchor, config);

        const lowCorrection = Math.abs(updatedLow.phase - predicted.phase);
        const highCorrection = Math.abs(updatedHigh.phase - predicted.phase);

        expect(highCorrection).toBeGreaterThan(lowCorrection);
    });

    it("clamps tau to valid range after update", () => {
        const predicted: CSFState = {
            phase: 5,
            tau: 25,
            phaseVar: 0.01,
            tauVar: 0.01,
            cov: 0.1,
        };
        const anchor: CSFAnchor = {
            dayNumber: 1,
            midpointHour: 20,
            weight: 10,
            record: {} as CSFAnchor["record"],
        };

        const updated = update(predicted, anchor, config);

        expect(updated.tau).toBeLessThanOrEqual(TAU_MAX);
        expect(updated.tau).toBeGreaterThanOrEqual(TAU_MIN);
    });
});

describe("forwardPass", () => {
    function makeAnchor(dayNumber: number, midpointHour: number, weight = 1): CSFAnchor {
        return {
            dayNumber,
            midpointHour,
            weight,
            record: {} as CSFAnchor["record"],
        };
    }

    it("produces states for each day in range", () => {
        const anchors = [makeAnchor(0, 3), makeAnchor(1, 4), makeAnchor(2, 5)];
        const states = forwardPass(anchors, 0, 2, DEFAULT_CONFIG);

        expect(states).toHaveLength(3);
    });

    it("handles missing anchors (gaps)", () => {
        const anchors = [makeAnchor(0, 3), makeAnchor(5, 8)];
        const states = forwardPass(anchors, 0, 5, DEFAULT_CONFIG);

        expect(states).toHaveLength(6);
    });

    it("phase drifts forward with tau > 24", () => {
        const anchors = [makeAnchor(0, 3)];
        const states = forwardPass(anchors, 0, 10, DEFAULT_CONFIG);

        const tau = DEFAULT_CONFIG.tauPrior;
        const expectedDrift = (tau - 24) * 10;

        expect(states[10]!.phase - states[0]!.phase).toBeCloseTo(expectedDrift, 1);
    });

    it("tau converges toward true drift with observations", () => {
        const trueTau = 25;
        const drift = trueTau - 24;

        const anchors: CSFAnchor[] = [];
        for (let d = 0; d < 60; d++) {
            anchors.push(makeAnchor(d, 3 + d * drift));
        }

        const states = forwardPass(anchors, 0, 59, DEFAULT_CONFIG);

        const finalTau = states[59]!.tau;
        expect(Math.abs(finalTau - trueTau)).toBeLessThan(0.5);
    });
});

describe("rtsSmoother", () => {
    function makeState(phase: number, tau: number): CSFState {
        return {
            phase,
            tau,
            phaseVar: 0.5,
            tauVar: 0.1,
            cov: 0.05,
        };
    }

    it("returns empty for empty input", () => {
        expect(rtsSmoother([], DEFAULT_CONFIG)).toHaveLength(0);
    });

    it("returns single state unchanged", () => {
        const states = [makeState(5, 25)];
        const smoothed = rtsSmoother(states, DEFAULT_CONFIG);

        expect(smoothed).toHaveLength(1);
        expect(smoothed[0]!.smoothedPhase).toBe(5);
        expect(smoothed[0]!.smoothedTau).toBe(25);
    });

    it("smooths phase backward in time", () => {
        const states = [makeState(0, 25), makeState(1, 25), makeState(10, 25), makeState(1, 25), makeState(2, 25)];

        const smoothed = rtsSmoother(states, DEFAULT_CONFIG);

        expect(smoothed[0]!.smoothedPhase).not.toBe(0);
    });

    it("last state has smoothedPhase = phase", () => {
        const states = [makeState(0, 25), makeState(1, 25), makeState(5, 25)];
        const smoothed = rtsSmoother(states, DEFAULT_CONFIG);

        const last = smoothed[smoothed.length - 1]!;
        expect(last.smoothedPhase).toBeCloseTo(last.phase, 6);
    });

    it("smoothed tau stays within bounds", () => {
        const states: CSFState[] = [];
        for (let i = 0; i < 30; i++) {
            states.push(makeState(i, 25 + Math.sin(i) * 2));
        }

        const smoothed = rtsSmoother(states, DEFAULT_CONFIG);

        for (const s of smoothed) {
            expect(s.smoothedTau).toBeGreaterThanOrEqual(TAU_MIN);
            expect(s.smoothedTau).toBeLessThanOrEqual(TAU_MAX);
        }
    });

    it("reduces variance through smoothing", () => {
        const states = [makeState(0, 25), makeState(1, 25), makeState(2, 25), makeState(3, 25), makeState(4, 25)];

        const smoothed = rtsSmoother(states, DEFAULT_CONFIG);

        for (let i = 0; i < smoothed.length - 1; i++) {
            expect(smoothed[i]!.smoothedPhaseVar).toBeLessThan(states[i]!.phaseVar);
        }
    });
});
