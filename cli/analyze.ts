import { readFileSync } from "node:fs";
import { parseSleepData } from "../src/data/loadLocalData.js";
import { analyzeWithAlgorithm, DEFAULT_ALGORITHM_ID, listAlgorithms } from "../src/models/circadian/index.js";
import type { RegressionAnalysis } from "../src/models/circadian/index.js";

const file = process.argv[2];
const algorithmId = process.argv[3] || DEFAULT_ALGORITHM_ID;

if (!file) {
    const algos = listAlgorithms()
        .map((a) => `  ${a.id}: ${a.name}`)
        .join("\n");
    console.error(`Usage: npx tsx cli/analyze.ts <sleep-data.json> [algorithmId]\n\nAlgorithms:\n${algos}`);
    process.exit(1);
}

const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
const records = parseSleepData(data);
const analysis = analyzeWithAlgorithm(algorithmId, records);

console.log(`Algorithm: ${algorithmId}`);
console.log(`Records: ${records.length}`);
if ("anchors" in analysis) {
    console.log(`Anchors: ${(analysis as RegressionAnalysis).anchors.length}`);
}
console.log(`Global tau: ${analysis.globalTau.toFixed(3)}h`);
console.log(`Daily drift: ${(analysis.globalDailyDrift * 60).toFixed(1)} min/day`);
