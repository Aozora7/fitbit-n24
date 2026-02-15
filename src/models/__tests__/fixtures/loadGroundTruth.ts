import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { SleepRecord } from "../../../api/types";
import type { OverlayDay } from "../../overlayPath";
import { parseSleepData } from "../../../data/loadLocalData";

const TEST_DATA_DIR = resolve(__dirname, "../../../../test-data");

export const hasTestData =
    existsSync(TEST_DATA_DIR) &&
    readdirSync(TEST_DATA_DIR).some((f) => f.endsWith(".json"));

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
