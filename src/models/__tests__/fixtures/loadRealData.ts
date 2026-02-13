import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SleepRecord } from "../../../api/types";
import { parseSleepData } from "../../../data/loadLocalData";

const DATA_PATH = resolve(__dirname, "../../../../public/dev-data/auto-import.json");

export const hasRealData = existsSync(DATA_PATH);

let cached: SleepRecord[] | null = null;

export function loadRealData(): SleepRecord[] {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(DATA_PATH, "utf-8"));
  cached = parseSleepData(raw);
  return cached;
}
