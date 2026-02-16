import type { SleepRecord } from "../../api/types";
import type { CircadianAnalysis } from "./types";

export interface CircadianAlgorithm {
    id: string;
    name: string;
    description: string;
    analyze: (records: SleepRecord[], extraDays?: number) => CircadianAnalysis;
}

export const ALGORITHMS: Record<string, CircadianAlgorithm> = {};

export function registerAlgorithm(algorithm: CircadianAlgorithm): void {
    if (ALGORITHMS[algorithm.id]) {
        console.warn(`[circadian] Overwriting existing algorithm: ${algorithm.id}`);
    }
    ALGORITHMS[algorithm.id] = algorithm;
}

export function getAlgorithm(id: string): CircadianAlgorithm | undefined {
    return ALGORITHMS[id];
}

export function listAlgorithms(): CircadianAlgorithm[] {
    return Object.values(ALGORITHMS);
}

export function getDefaultAlgorithm(): CircadianAlgorithm | undefined {
    const ids = Object.keys(ALGORITHMS);
    return ids.length > 0 ? ALGORITHMS[ids[0]!] : undefined;
}
