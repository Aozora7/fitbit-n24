// Rauch-Tung-Striebel backward smoother for 2D state
import type { State, Cov } from "./types";

/**
 * Invert a 2x2 symmetric matrix stored as [a, b, d] where matrix is [[a,b],[b,d]].
 * Returns [a', b', d'] or null if singular.
 */
function invert2x2(m: Cov): Cov | null {
    const [a, b, d] = m;
    const det = a * d - b * b;
    if (Math.abs(det) < 1e-12) return null;
    const invDet = 1 / det;
    return [d * invDet, -b * invDet, a * invDet];
}

/**
 * Multiply 2x2 symmetric P by F^T where F = [[1,1],[0,1]].
 * P*F^T = [[p00+p01, p01], [p01+p11, p11]]
 * Returns as full 2x2: [r00, r01, r10, r11].
 */
function mulPFt(p: Cov): [number, number, number, number] {
    const [p00, p01, p11] = p;
    return [p00 + p01, p01, p01 + p11, p11];
}

/**
 * RTS backward smoother.
 *
 * Takes arrays of filtered and predicted states/covariances from the forward pass.
 * Returns smoothed states and covariances.
 *
 * filtered[t] = state/cov after update at time t
 * predicted[t+1] = state/cov after predict from t to t+1
 */
export function rtsSmoother(
    filteredStates: State[],
    filteredCovs: Cov[],
    predictedStates: State[],
    predictedCovs: Cov[],
): { states: State[]; covs: Cov[] } {
    const n = filteredStates.length;
    const smoothedStates: State[] = new Array(n);
    const smoothedCovs: Cov[] = new Array(n);

    // Last time step: smoothed = filtered
    smoothedStates[n - 1] = filteredStates[n - 1]!;
    smoothedCovs[n - 1] = filteredCovs[n - 1]!;

    for (let t = n - 2; t >= 0; t--) {
        const pFilt = filteredCovs[t]!;
        const pPred = predictedCovs[t + 1]!;

        // G = P_filt * F^T * P_pred^{-1}
        const pft = mulPFt(pFilt);
        const pPredInv = invert2x2(pPred);

        if (!pPredInv) {
            // Singular predicted covariance — keep filtered estimate
            smoothedStates[t] = filteredStates[t]!;
            smoothedCovs[t] = filteredCovs[t]!;
            continue;
        }

        // G = PF^T * P_pred^{-1} (2x2 × 2x2)
        const [a, b, c, d] = pft;
        const [i0, i1, i2] = pPredInv; // [[i0, i1], [i1, i2]]
        const g00 = a * i0 + b * i1;
        const g01 = a * i1 + b * i2;
        const g10 = c * i0 + d * i1;
        const g11 = c * i1 + d * i2;

        // x_smooth = x_filt + G * (x_smooth[t+1] - x_pred[t+1])
        const dx0 = smoothedStates[t + 1]![0] - predictedStates[t + 1]![0];
        const dx1 = smoothedStates[t + 1]![1] - predictedStates[t + 1]![1];

        const xf = filteredStates[t]!;
        smoothedStates[t] = [xf[0] + g00 * dx0 + g01 * dx1, xf[1] + g10 * dx0 + g11 * dx1];

        // P_smooth = P_filt + G * (P_smooth[t+1] - P_pred[t+1]) * G^T
        const dP0 = smoothedCovs[t + 1]![0] - pPred[0];
        const dP1 = smoothedCovs[t + 1]![1] - pPred[1];
        const dP2 = smoothedCovs[t + 1]![2] - pPred[2];

        // G * dP: 2x2 × 2x2 symmetric
        const gd00 = g00 * dP0 + g01 * dP1;
        const gd01 = g00 * dP1 + g01 * dP2;
        const gd10 = g10 * dP0 + g11 * dP1;
        const gd11 = g10 * dP1 + g11 * dP2;

        // (G * dP) * G^T
        const sp00 = gd00 * g00 + gd01 * g10;
        const sp01 = gd00 * g01 + gd01 * g11;
        const sp11 = gd10 * g01 + gd11 * g11;

        smoothedCovs[t] = [pFilt[0] + sp00, pFilt[1] + sp01, pFilt[2] + sp11];
    }

    return { states: smoothedStates, covs: smoothedCovs };
}
