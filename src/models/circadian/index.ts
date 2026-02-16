// Circadian analysis — public API and algorithm registry
import type { SleepRecord } from "../../api/types";
import type { CircadianAnalysis } from "./types";
import type { RegressionAnalysis } from "./regression/types";
import { registerAlgorithm, getAlgorithm, listAlgorithms } from "./registry";
import type { CircadianAlgorithm } from "./registry";
import {
    analyzeCircadian as analyzeRegression,
    ALGORITHM_ID as REGRESSION_ALGORITHM_ID,
    _internals,
} from "./regression";
import { analyzeCircadian as analyzeKalman, ALGORITHM_ID as KALMAN_ALGORITHM_ID } from "./kalman";
import { analyzeCircadian as analyzeCSF, ALGORITHM_ID as CSF_ALGORITHM_ID } from "./csf";

export type { CircadianDay, CircadianAnalysis } from "./types";
export type { RegressionAnalysis, AnchorPoint } from "./regression/types";
export type { KalmanAnalysis } from "./kalman/types";
export type { CSFAnalysis, CSFConfig } from "./csf/types";
export type { CircadianAlgorithm } from "./registry";
export { registerAlgorithm, getAlgorithm, listAlgorithms } from "./registry";
export { splitIntoSegments } from "./segments";
export { GAP_THRESHOLD_DAYS } from "./types";

const regressionAlgorithm: CircadianAlgorithm = {
    id: REGRESSION_ALGORITHM_ID,
    name: "Weighted Regression",
    description: "Anchor-based weighted regression with sliding window evaluation and robust outlier handling",
    analyze: analyzeRegression,
};

registerAlgorithm(regressionAlgorithm);

const kalmanAlgorithm: CircadianAlgorithm = {
    id: KALMAN_ALGORITHM_ID,
    name: "Kalman Filter",
    description: "State-space model with forward Kalman filter and RTS backward smoother for optimal phase tracking",
    analyze: analyzeKalman,
};

registerAlgorithm(kalmanAlgorithm);

const csfAlgorithm: CircadianAlgorithm = {
    id: CSF_ALGORITHM_ID,
    name: "Circular State-Space Filter",
    description: "Von Mises circular filter with RTS smoother - native circular phase handling without unwrapping",
    analyze: analyzeCSF,
};

registerAlgorithm(csfAlgorithm);

export const DEFAULT_ALGORITHM_ID = REGRESSION_ALGORITHM_ID;

export function analyzeCircadian(records: SleepRecord[], extraDays: number = 0): RegressionAnalysis {
    return analyzeRegression(records, extraDays);
}

export function analyzeWithAlgorithm(
    algorithmId: string,
    records: SleepRecord[],
    extraDays: number = 0
): CircadianAnalysis {
    const algorithm = getAlgorithm(algorithmId);
    if (!algorithm) {
        throw new Error(
            `Unknown algorithm: ${algorithmId}. Available: ${Object.keys(listAlgorithms().map((a) => a.id)).join(", ")}`
        );
    }
    return algorithm.analyze(records, extraDays);
}

export { _internals };
