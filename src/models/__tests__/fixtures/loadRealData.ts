import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SleepRecord } from "../../../api/types";
import { parseSleepData } from "../../../data/loadLocalData";

const TEST_DATA_DIR = resolve(__dirname, "../../../../test-data");

const cache = new Map<string, SleepRecord[]>();

export function hasRealData(fileName: string): boolean {
    return existsSync(resolve(TEST_DATA_DIR, fileName));
}

export function loadRealData(fileName: string): SleepRecord[] {
    const cached = cache.get(fileName);
    if (cached) return cached;
    const raw = JSON.parse(readFileSync(resolve(TEST_DATA_DIR, fileName), "utf-8"));
    const records = parseSleepData(raw.sleep ?? raw);
    cache.set(fileName, records);
    return records;
}
