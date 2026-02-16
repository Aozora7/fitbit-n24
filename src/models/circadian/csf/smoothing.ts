import type { SmoothedState } from "./types";

export function smoothOutputPhase(
    states: SmoothedState[],
    sigmaDays: number = 2,
    halfWindow: number = 3
): SmoothedState[] {
    if (states.length < 3) return states;

    const smoothed: SmoothedState[] = states.map((s) => ({ ...s }));

    for (let i = 0; i < states.length; i++) {
        let phaseSum = 0;
        let tauSum = 0;
        let weightSum = 0;

        for (let j = Math.max(0, i - halfWindow); j <= Math.min(states.length - 1, i + halfWindow); j++) {
            const dist = Math.abs(j - i);
            const weight = Math.exp(-0.5 * (dist / sigmaDays) ** 2);
            phaseSum += weight * states[j]!.smoothedPhase;
            tauSum += weight * states[j]!.smoothedTau;
            weightSum += weight;
        }

        if (weightSum > 0) {
            smoothed[i]!.smoothedPhase = phaseSum / weightSum;
            smoothed[i]!.smoothedTau = tauSum / weightSum;
        }
    }

    return smoothed;
}
