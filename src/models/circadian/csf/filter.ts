import type { CSFConfig, CSFState, SmoothedState, CSFAnchor } from "./types";
import { TAU_MIN, TAU_MAX } from "./types";

export function normalizeAngle(angle: number): number {
    return ((angle % 24) + 24) % 24;
}

export function circularDiff(a: number, b: number): number {
    const diff = normalizeAngle(a) - normalizeAngle(b);
    if (diff > 12) return diff - 24;
    if (diff < -12) return diff + 24;
    return diff;
}

export function resolveAmbiguity(measurement: number, predictedPhase: number): number {
    return measurement + Math.round((predictedPhase - measurement) / 24) * 24;
}

export function vonMisesUpdate(
    priorPhase: number,
    priorKappa: number,
    measurement: number,
    measurementKappa: number
): { phase: number; kappa: number } {
    const TWO_PI = 2 * Math.PI;
    const scale = TWO_PI / 24;

    const C_prior = priorKappa * Math.cos(priorPhase * scale);
    const S_prior = priorKappa * Math.sin(priorPhase * scale);
    const C_meas = measurementKappa * Math.cos(measurement * scale);
    const S_meas = measurementKappa * Math.sin(measurement * scale);

    const C_post = C_prior + C_meas;
    const S_post = S_prior + S_meas;

    const R = Math.sqrt(C_post * C_post + S_post * S_post);
    const postKappa = Math.max(R, 0.001);
    const postPhase = Math.atan2(S_post, C_post) / scale;

    return {
        phase: postPhase,
        kappa: postKappa,
    };
}

export function initializeState(firstAnchor: CSFAnchor, config: CSFConfig): CSFState {
    return {
        phase: firstAnchor.midpointHour,
        tau: config.tauPrior,
        phaseVar: 1.0,
        tauVar: config.tauPriorVar,
        cov: 0,
    };
}

export function predict(state: CSFState, config: CSFConfig): CSFState {
    const driftPerDay = state.tau - 24;
    const newPhase = state.phase + driftPerDay;

    const newPhaseVar = Math.max(0.01, state.phaseVar + 2 * state.cov + state.tauVar + config.processNoisePhase);
    const newTauVar = Math.max(0.001, state.tauVar + config.processNoiseTau);
    const newCov = Math.min(state.cov + state.tauVar, 10);

    return {
        phase: newPhase,
        tau: state.tau,
        tauVar: newTauVar,
        phaseVar: newPhaseVar,
        cov: newCov,
    };
}

export function updatePrior(state: CSFState, config: CSFConfig): CSFState {
    const drift = state.tau - 24;
    const priorDrift = config.tauPrior - 24;

    let R: number;
    if (drift < 0) {
        R = config.tauPriorNoise.forward;
    } else if (drift > priorDrift) {
        R = config.tauPriorNoise.backward;
    } else {
        R = config.tauPriorNoise.none;
    }

    const K = state.tauVar / (state.tauVar + R);
    const innovation = config.tauPrior - state.tau;

    const updatedTau = state.tau + K * innovation;
    const updatedTauVar = (1 - K) * state.tauVar;

    // Covariance update: P_phase_tau = P_phase_tau - K * P_phase_tau = (1-K) * P_phase_tau
    // Since we're updating tau directly, the cross-term scales similarly.
    const updatedCov = (1 - K) * state.cov;

    return {
        ...state,
        tau: Math.max(TAU_MIN, Math.min(TAU_MAX, updatedTau)),
        tauVar: Math.max(0.001, updatedTauVar),
        cov: updatedCov,
    };
}

export function update(predicted: CSFState, anchor: CSFAnchor, config: CSFConfig): CSFState {
    const measurementKappa = Math.max(0.001, config.measurementKappaBase * anchor.weight);
    const priorKappa = Math.max(0.001, 1 / Math.max(predicted.phaseVar, 0.01));

    const resolvedMeasurement = resolveAmbiguity(anchor.midpointHour, predicted.phase);

    // Mahalanobis distance gating
    const phaseResidual = circularDiff(resolvedMeasurement, predicted.phase);
    const innovationVar = Math.max(0.01, predicted.phaseVar + 1 / measurementKappa);
    const mahalanobisSq = (phaseResidual * phaseResidual) / innovationVar;

    if (mahalanobisSq > config.gateThreshold * config.gateThreshold) {
        return predicted;
    }

    const normalizedPredicted = normalizeAngle(predicted.phase);
    const normalizedMeasurement = normalizeAngle(resolvedMeasurement);

    const { phase: updatedPhaseCircular, kappa: updatedKappa } = vonMisesUpdate(
        normalizedPredicted,
        priorKappa,
        normalizedMeasurement,
        measurementKappa
    );

    let phaseCorrection = circularDiff(updatedPhaseCircular, normalizedPredicted);

    // Clamp maximum phase correction per step to prevent branch-jumping
    phaseCorrection = Math.max(-config.maxCorrectionPerStep, Math.min(config.maxCorrectionPerStep, phaseCorrection));

    const updatedPhase = predicted.phase + phaseCorrection;

    // Clamp tau innovation consistently with phase correction clamp
    const clampedInnovation = Math.max(
        -config.maxCorrectionPerStep,
        Math.min(config.maxCorrectionPerStep, phaseResidual)
    );
    const kalmanGain = predicted.cov / innovationVar;

    let updatedTau = predicted.tau + kalmanGain * clampedInnovation;
    if (!Number.isFinite(updatedTau)) {
        updatedTau = predicted.tau;
    }
    updatedTau = Math.max(TAU_MIN, Math.min(TAU_MAX, updatedTau));

    const updatedTauVar = Math.max(0.001, predicted.tauVar - kalmanGain * predicted.cov);
    const updatedCov = predicted.cov - kalmanGain * innovationVar;

    return {
        phase: updatedPhase,
        tau: updatedTau,
        phaseVar: Math.max(0.01, 1 / Math.max(updatedKappa, 0.001)),
        tauVar: updatedTauVar,
        cov: Math.min(updatedCov, 1.0),
    };
}

export function forwardPass(anchors: CSFAnchor[], firstDay: number, lastDay: number, config: CSFConfig): CSFState[] {
    const anchorByDay = new Map(anchors.map((a) => [a.dayNumber, a] as const));

    const firstAnchor = anchors[0]!;
    let state = initializeState(firstAnchor, config);
    const states: CSFState[] = [state];

    for (let t = firstDay + 1; t <= lastDay; t++) {
        state = predict(state, config);

        const anchor = anchorByDay.get(t);
        if (anchor) {
            state = update(state, anchor, config);
        }

        state = updatePrior(state, config);

        states.push(state);
    }

    return states;
}

export function rtsSmoother(forwardStates: CSFState[], config: CSFConfig): SmoothedState[] {
    const n = forwardStates.length;
    if (n === 0) return [];

    const smoothed: SmoothedState[] = forwardStates.map((s) => ({
        ...s,
        smoothedPhase: s.phase,
        smoothedTau: s.tau,
        smoothedPhaseVar: s.phaseVar,
        smoothedTauVar: s.tauVar,
    }));

    for (let t = n - 2; t >= 0; t--) {
        const curr = smoothed[t]!;
        const next = smoothed[t + 1]!;

        const predictedNextVar = Math.max(0.01, curr.phaseVar + 2 * curr.cov + curr.tauVar + config.processNoisePhase);
        const gain = Math.min(0.95, Math.max(0.1, curr.phaseVar / predictedNextVar));

        const expectedPhase = curr.phase + (curr.tau - 24);
        const phaseInnov = circularDiff(next.smoothedPhase, expectedPhase);
        const tauInnov = next.smoothedTau - curr.tau;

        let smoothedTau = curr.tau + gain * tauInnov;
        if (!Number.isFinite(smoothedTau)) {
            smoothedTau = curr.tau;
        }
        smoothedTau = Math.max(TAU_MIN, Math.min(TAU_MAX, smoothedTau));

        smoothed[t]!.smoothedPhase = curr.phase + gain * phaseInnov;
        smoothed[t]!.smoothedTau = smoothedTau;
        smoothed[t]!.smoothedPhaseVar = Math.max(0.01, curr.phaseVar * (1 - gain));
        smoothed[t]!.smoothedTauVar = Math.max(0.001, curr.tauVar * (1 - gain));
    }

    return smoothed;
}
