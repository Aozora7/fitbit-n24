import { readFileSync } from "node:fs";
import { parseSleepData } from "../src/data/loadLocalData.js";
import { analyzeCircadian } from "../src/models/circadian.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npx tsx cli/analyze.ts <sleep-data.json>");
  process.exit(1);
}

const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
const records = parseSleepData(data);
const analysis = analyzeCircadian(records);

console.log(`Records: ${records.length}`);
console.log(`Anchors: ${analysis.anchors.length}`);
console.log(`Global tau: ${analysis.globalTau.toFixed(3)}h`);
console.log(`Daily drift: ${(analysis.globalDailyDrift * 60).toFixed(1)} min/day`);
