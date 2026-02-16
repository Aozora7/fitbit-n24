// Kalman filter core operations for 2D state [phase, drift]
import type { State, Cov } from "./types";
import { Q_PHASE, Q_DRIFT } from "./types";

/**
 * State transition: phase += drift, drift unchanged.
 * F = [[1, 1], [0, 1]], Q = diag(Q_PHASE, Q_DRIFT)
 */
export function predict(state: State, cov: Cov): { state: State; cov: Cov } {
    const [phase, drift] = state;
    const [p00, p01, p11] = cov;

    // x_pred = F * x
    const predPhase = phase + drift;
    const predDrift = drift;

    // P_pred = F * P * F^T + Q
    // F*P = [[p00+p01, p01+p11], [p01, p11]]
    // F*P*F^T = [[p00+2*p01+p11, p01+p11], [p01+p11, p11]]
    const pp00 = p00 + 2 * p01 + p11 + Q_PHASE;
    const pp01 = p01 + p11;
    const pp11 = p11 + Q_DRIFT;

    return {
        state: [predPhase, predDrift],
        cov: [pp00, pp01, pp11],
    };
}

/**
 * Measurement update with observation z and noise R.
 * H = [1, 0] (observe phase only).
 */
export function update(
    state: State,
    cov: Cov,
    z: number,
    R: number,
): { state: State; cov: Cov; innovation: number } {
    const [phase, drift] = state;
    const [p00, p01, p11] = cov;

    // Innovation
    const innovation = z - phase;

    // S = H * P * H^T + R = p00 + R
    const S = p00 + R;

    // K = P * H^T / S = [p00/S, p01/S]
    const k0 = p00 / S;
    const k1 = p01 / S;

    // x_upd = x + K * innovation
    const updPhase = phase + k0 * innovation;
    const updDrift = drift + k1 * innovation;

    // P_upd = (I - K*H) * P
    const up00 = p00 - k0 * p00;
    const up01 = p01 - k0 * p01;
    const up11 = p11 - k1 * p01;

    return {
        state: [updPhase, updDrift],
        cov: [up00, up01, up11],
        innovation,
    };
}

/**
 * Mahalanobis distance gating. Returns true if observation should be rejected.
 * d² = innovation² / S where S = p00 + R.
 */
export function gate(
    state: State,
    cov: Cov,
    z: number,
    R: number,
    threshold: number,
): boolean {
    const innovation = z - state[0];
    const S = cov[0] + R;
    const d2 = (innovation * innovation) / S;
    return d2 > threshold * threshold;
}

/**
 * Resolve 24h ambiguity: snap z_raw to the branch closest to predicted phase.
 */
export function resolveAmbiguity(zRaw: number, predictedPhase: number): number {
    return zRaw + Math.round((predictedPhase - zRaw) / 24) * 24;
}
