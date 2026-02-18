// Circadian analysis — public API and algorithm registry
import type { SleepRecord } from "../../api/types";
import type { CircadianAnalysis } from "./types";
import { registerAlgorithm, getAlgorithm, listAlgorithms } from "./registry";
import type { CircadianAlgorithm } from "./registry";

import { analyzeCircadian as analyzeCSF, ALGORITHM_ID as CSF_ALGORITHM_ID } from "./csf";

export type { CircadianDay, CircadianAnalysis } from "./types";

export type { CSFAnalysis, CSFConfig } from "./csf/types";
export type { CircadianAlgorithm } from "./registry";
export { registerAlgorithm, getAlgorithm, listAlgorithms } from "./registry";
export { splitIntoSegments } from "./segments";
export { GAP_THRESHOLD_DAYS } from "./types";

const csfAlgorithm: CircadianAlgorithm = {
    id: CSF_ALGORITHM_ID,
    name: "Circular State-Space Filter",
    description: "Von Mises circular filter with RTS smoother - native circular phase handling without unwrapping",
    analyze: analyzeCSF,
};

registerAlgorithm(csfAlgorithm);

export const DEFAULT_ALGORITHM_ID = CSF_ALGORITHM_ID;

const isDevMode = typeof import.meta.env !== "undefined" && import.meta.env.DEV;
const isNodeCLI = typeof window === "undefined";
if (isDevMode || isNodeCLI) {
    //optional algorithms for development
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
