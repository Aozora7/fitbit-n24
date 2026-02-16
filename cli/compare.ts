import { readFileSync } from "node:fs";
import { parseSleepData } from "../src/data/loadLocalData.js";
import { listAlgorithms, analyzeWithAlgorithm } from "../src/models/circadian";
import type { CircadianAnalysis } from "../src/models/circadian";

const file = process.argv[2];
if (!file) {
    console.error("Usage: npx tsx cli/compare.ts <sleep-data.json> [algorithmIds...]");
    console.error("\nAvailable algorithms:");
    for (const algo of listAlgorithms()) {
        console.error(`  ${algo.id}: ${algo.name}`);
    }
    process.exit(1);
}

const algorithmIds = process.argv.slice(3);
const allAlgorithms = listAlgorithms();
const idsToRun = algorithmIds.length > 0 ? algorithmIds : allAlgorithms.map((a) => a.id);

const unknownIds = idsToRun.filter((id) => !allAlgorithms.some((a) => a.id === id));
if (unknownIds.length > 0) {
    console.error(`Unknown algorithm(s): ${unknownIds.join(", ")}`);
    console.error("Available: " + allAlgorithms.map((a) => a.id).join(", "));
    process.exit(1);
}

const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
const records = parseSleepData(data);

if (records.length === 0) {
    console.error("No sleep records found in file");
    process.exit(1);
}

console.log(`Records: ${records.length}`);
console.log("");

interface ScoredResult {
    id: string;
    name: string;
    analysis: CircadianAnalysis;
    meanDrift: number;
    maxJump: number;
    forecastConfidence: number;
}

const results: ScoredResult[] = [];

for (const id of idsToRun) {
    const algo = allAlgorithms.find((a) => a.id === id)!;
    const analysis = analyzeWithAlgorithm(id, records);

    const dataDays = analysis.days.filter((d) => !d.isForecast && !d.isGap);
    const forecastDays = analysis.days.filter((d) => d.isForecast);

    let meanDrift = 0;
    if (dataDays.length > 1) {
        let prevMid = (dataDays[0]!.nightStartHour + dataDays[0]!.nightEndHour) / 2;
        let totalDrift = 0;
        for (let i = 1; i < dataDays.length; i++) {
            const mid = (dataDays[i]!.nightStartHour + dataDays[i]!.nightEndHour) / 2;
            let delta = mid - prevMid;
            if (delta > 12) delta -= 24;
            if (delta < -12) delta += 24;
            totalDrift += delta;
            prevMid = mid;
        }
        meanDrift = totalDrift / (dataDays.length - 1);
    }

    let maxJump = 0;
    for (let i = 1; i < dataDays.length; i++) {
        const prevMid = (dataDays[i - 1]!.nightStartHour + dataDays[i - 1]!.nightEndHour) / 2;
        const currMid = (dataDays[i]!.nightStartHour + dataDays[i]!.nightEndHour) / 2;
        let delta = Math.abs(currMid - prevMid);
        if (delta > 12) delta = 24 - delta;
        maxJump = Math.max(maxJump, delta);
    }

    const forecastConfidence =
        forecastDays.length > 0 ? forecastDays.reduce((s, d) => s + d.confidenceScore, 0) / forecastDays.length : 0;

    results.push({
        id,
        name: algo.name,
        analysis,
        meanDrift,
        maxJump,
        forecastConfidence,
    });
}

console.log("| Algorithm       | Tau      | Drift     | Mean Err | P90 Err | Max Jump | Penalty |");
console.log("|-----------------|----------|-----------|----------|---------|----------|---------|");

for (const r of results) {
    const dataDays = r.analysis.days.filter((d) => !d.isForecast && !d.isGap);
    const errors: number[] = [];
    for (const day of dataDays) {
        const predictedMid = (day.nightStartHour + day.nightEndHour) / 2;
        const normalized = ((predictedMid % 24) + 24) % 24;
        const expectedMid = 3;
        let err = Math.abs(normalized - expectedMid);
        if (err > 12) err = 24 - err;
        errors.push(err);
    }
    errors.sort((a, b) => a - b);
    const meanErr = errors.length > 0 ? errors.reduce((s, e) => s + e, 0) / errors.length : 0;
    const p90Err = errors.length > 0 ? errors[Math.floor(errors.length * 0.9)]! : 0;

    const penalty = r.maxJump > 3 ? r.maxJump - 3 : 0;

    console.log(
        `| ${r.name.padEnd(15)} | ${r.analysis.globalTau.toFixed(2).padStart(6)}h | ` +
            `${r.meanDrift * 60 >= 0 ? "+" : ""}${(r.meanDrift * 60).toFixed(0).padStart(4)}min/d | ` +
            `${meanErr.toFixed(2).padStart(8)}h | ${p90Err.toFixed(2).padStart(5)}h | ` +
            `${r.maxJump.toFixed(2).padStart(8)}h | ${penalty.toFixed(2).padStart(7)} |`
    );
}

console.log("");
console.log("Summary:");
for (const r of results) {
    console.log(
        `  ${r.name}: τ=${r.analysis.globalTau.toFixed(4)}h, ${(r.analysis.globalDailyDrift * 60).toFixed(1)} min/day drift`
    );
}
