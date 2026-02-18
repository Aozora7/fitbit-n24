import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SleepRecord } from "../../../api/types";
import type { OverlayDay } from "../../overlayPath";
import { parseSleepData } from "../../../data/loadLocalData";

const TEST_DATA_DIR = resolve(__dirname, "../../../../test-data");
const BASELINES_DIR = resolve(TEST_DATA_DIR, "baselines");

export const hasTestData = existsSync(TEST_DATA_DIR) && readdirSync(TEST_DATA_DIR).some((f) => f.endsWith(".json"));

export interface GroundTruthDataset {
    name: string;
    records: SleepRecord[];
    overlay: OverlayDay[];
}

export function listGroundTruthDatasets(): GroundTruthDataset[] {
    if (!hasTestData) return [];
    return readdirSync(TEST_DATA_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
            const raw = JSON.parse(readFileSync(join(TEST_DATA_DIR, f), "utf-8"));
            if (!raw.sleep || !raw.overlay) {
                throw new Error(`test-data/${f}: missing "sleep" or "overlay" key`);
            }
            return {
                name: f.replace(/\.json$/, ""),
                records: parseSleepData(raw.sleep),
                overlay: raw.overlay as OverlayDay[],
            };
        });
}

export interface BaselineFile {
    algorithmId: string;
    dataset: string;
    recordedAt: string;
    stats: Record<string, unknown>;
}

export function getBaselinePath(datasetName: string, algorithmId: string): string {
    return join(BASELINES_DIR, `${datasetName}.${algorithmId}.json`);
}

export function loadBaseline(datasetName: string, algorithmId: string): BaselineFile | null {
    const path = getBaselinePath(datasetName, algorithmId);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as BaselineFile;
}

export function saveBaseline(datasetName: string, algorithmId: string, stats: Record<string, unknown>): void {
    if (!existsSync(BASELINES_DIR)) {
        mkdirSync(BASELINES_DIR, { recursive: true });
    }
    const baseline: BaselineFile = {
        algorithmId,
        dataset: datasetName,
        recordedAt: new Date().toISOString(),
        stats,
    };
    writeFileSync(getBaselinePath(datasetName, algorithmId), JSON.stringify(baseline, null, 2));
}
