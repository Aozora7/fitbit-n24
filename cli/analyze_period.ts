/**
 * Diagnostic script for analyzing a specific date range.
 * Usage: npx tsx cli/analyze_period.ts <sleep-data.json> [startDate] [endDate]
 * Example: npx tsx cli/analyze_period.ts data.json 2023-10-14 2023-10-26
 */
import { readFileSync } from "node:fs";
import { parseSleepData } from "../src/data/loadLocalData.js";
import { analyzeCircadian, _internals } from "../src/models/circadian.js";
import type { SleepRecord } from "../src/api/types.js";

const { classifyAnchor, sleepMidpointHour, evaluateWindow, gaussian } = _internals;

const file = process.argv[2];
const startDate = process.argv[3] || "2023-10-01";
const endDate = process.argv[4] || "2023-11-15";

if (!file) {
  console.error("Usage: npx tsx cli/analyze_period.ts <sleep-data.json> [startDate] [endDate]");
  process.exit(1);
}

const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
const records = parseSleepData(data);
const analysis = analyzeCircadian(records);

console.log(`=== Period analysis: ${startDate} to ${endDate} ===\n`);
console.log(`Global: tau=${analysis.globalTau.toFixed(4)}h, drift=${(analysis.globalDailyDrift * 60).toFixed(1)} min/day`);
console.log(`Total anchors: ${analysis.anchors.length}\n`);

// Filter days and anchors in the target range
const targetDays = analysis.days.filter(d => d.date >= startDate && d.date <= endDate && !d.isForecast);
const targetAnchors = analysis.anchors.filter(a => a.date >= startDate && a.date <= endDate);

console.log(`--- Anchors in range (${targetAnchors.length}) ---`);
for (const a of targetAnchors) {
  const midHour = a.midpointHour % 24;
  const h = Math.floor(((midHour % 24) + 24) % 24);
  const m = Math.round((((midHour % 24) + 24) % 24 - h) * 60);
  console.log(
    `  ${a.date}  day=${a.dayNumber}  mid=${h}:${String(m).padStart(2, "0")}  ` +
    `unwrapped=${a.midpointHour.toFixed(1)}h  tier=${a.tier}  weight=${a.weight.toFixed(3)}`
  );
}

// Also show raw sleep records in the range
const rangeRecords = records
  .filter(r => r.dateOfSleep >= startDate && r.dateOfSleep <= endDate)
  .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

console.log(`\n--- All sleep records in range (${rangeRecords.length}) ---`);
for (const r of rangeRecords) {
  const startH = r.startTime.getHours() + r.startTime.getMinutes() / 60;
  const endH = r.endTime.getHours() + r.endTime.getMinutes() / 60;
  const cls = classifyAnchor(r);
  const tierStr = cls ? `tier=${cls.tier} w=${cls.weight.toFixed(3)}` : "not-anchor";
  console.log(
    `  ${r.dateOfSleep}  ${r.startTime.toLocaleTimeString()}-${r.endTime.toLocaleTimeString()}  ` +
    `dur=${r.durationHours.toFixed(1)}h  main=${r.isMainSleep}  score=${(r.sleepScore * 100).toFixed(0)}  ${tierStr}`
  );
}

// Show overlay day-by-day with analysis
console.log(`\n--- Overlay entries ---`);
console.log(`  ${"date".padEnd(12)} ${"mid".padEnd(7)} ${"start-end".padEnd(15)} tau     conf    drift`);
let prevMid: number | null = null;
for (const d of targetDays) {
  const mid = (d.nightStartHour + d.nightEndHour) / 2;
  const normMid = ((mid % 24) + 24) % 24;
  const h = Math.floor(normMid);
  const m = Math.round((normMid - h) * 60);
  const midStr = `${h}:${String(m).padStart(2, "0")}`;

  const startNorm = ((d.nightStartHour % 24) + 24) % 24;
  const endNorm = ((d.nightEndHour % 24) + 24) % 24;
  const sH = Math.floor(startNorm);
  const sM = Math.round((startNorm - sH) * 60);
  const eH = Math.floor(endNorm);
  const eM = Math.round((endNorm - eH) * 60);
  const rangeStr = `${sH}:${String(sM).padStart(2, "0")}-${eH}:${String(eM).padStart(2, "0")}`;

  let shiftStr = "     ";
  if (prevMid !== null) {
    let shift = normMid - prevMid;
    if (shift > 12) shift -= 24;
    if (shift < -12) shift += 24;
    shiftStr = `${shift >= 0 ? "+" : ""}${shift.toFixed(2)}`;
  }

  console.log(
    `  ${d.date}  ${midStr.padEnd(7)} ${rangeStr.padEnd(15)} ${d.localTau.toFixed(3)}  ${d.confidenceScore.toFixed(3)}  ${shiftStr}`
  );
  prevMid = normMid;
}

// Show what the regression looks like for specific days in the range
console.log(`\n--- Local regression details (sampled) ---`);

// Reconstruct anchors for evaluateWindow (need full anchor set).
// evaluateWindow expects internal Anchor objects with a `record` property
// (used only for avgDuration on tier A). Build stubs with default duration.
const sorted = [...records].sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
const firstDateMs = new Date(sorted[0]!.dateOfSleep + "T00:00:00").getTime();

const internalAnchors = analysis.anchors.map(a => ({
  ...a,
  record: { durationHours: 8 } as SleepRecord,
}));

// Compute day numbers for the target dates
const startDayNum = Math.round((new Date(startDate + "T00:00:00").getTime() - firstDateMs) / 86_400_000);
const endDayNum = Math.round((new Date(endDate + "T00:00:00").getTime() - firstDateMs) / 86_400_000);

// Show which anchors are in the window for a few sample days
const sampleDays = [startDayNum, Math.floor((startDayNum + endDayNum) / 2), endDayNum];
const WINDOW_HALF = 21;
const GAUSSIAN_SIGMA = 14;

for (const d of sampleDays) {
  const dayDate = new Date(firstDateMs);
  dayDate.setDate(dayDate.getDate() + d);
  const dateStr = dayDate.getFullYear() + "-" + String(dayDate.getMonth() + 1).padStart(2, "0") + "-" + String(dayDate.getDate()).padStart(2, "0");

  const result = evaluateWindow(internalAnchors, d, WINDOW_HALF);
  const pred = result.slope * d + result.intercept;
  const normPred = ((pred % 24) + 24) % 24;

  // Compute slopeConf
  const medianSpacing = analysis.anchors.length > 1
    ? (() => {
        const spacings: number[] = [];
        for (let i = 1; i < analysis.anchors.length; i++) {
          spacings.push(analysis.anchors[i]!.dayNumber - analysis.anchors[i - 1]!.dayNumber);
        }
        spacings.sort((a, b) => a - b);
        return spacings[Math.floor(spacings.length / 2)]!;
      })()
    : 1;
  const expectedPts = medianSpacing > 0 ? (WINDOW_HALF * 2) / medianSpacing : 10;
  const slopeConf = Math.min(1, result.pointsUsed / expectedPts) *
                    (1 - Math.min(1, result.residualMAD / 4));

  console.log(`\n  Day ${d} (${dateStr}):`);
  console.log(`    Window: ±${WINDOW_HALF} days, ${result.pointsUsed} anchors used`);
  console.log(`    Raw slope: ${result.slope.toFixed(4)} (tau=${(24 + result.slope).toFixed(4)})`);
  console.log(`    Prediction at d: ${normPred.toFixed(2)}h (unwrapped: ${pred.toFixed(1)}h)`);
  console.log(`    Residual MAD: ${result.residualMAD.toFixed(2)}h`);
  console.log(`    slopeConf: ${slopeConf.toFixed(3)}`);
  console.log(`    Centroid (weightedMeanX): day ${result.weightedMeanX.toFixed(1)} (offset=${(d - result.weightedMeanX).toFixed(1)})`);

  // Show anchors in the window with their weights
  const windowAnchors = analysis.anchors
    .filter(a => Math.abs(a.dayNumber - d) <= WINDOW_HALF)
    .map(a => ({
      ...a,
      dist: Math.abs(a.dayNumber - d),
      gw: gaussian(Math.abs(a.dayNumber - d), GAUSSIAN_SIGMA),
      totalWeight: a.weight * gaussian(Math.abs(a.dayNumber - d), GAUSSIAN_SIGMA),
    }))
    .sort((a, b) => a.dayNumber - b.dayNumber);

  console.log(`    Anchors in window:`);
  for (const a of windowAnchors) {
    const midNorm = ((a.midpointHour % 24) + 24) % 24;
    const inRange = a.date >= startDate && a.date <= endDate ? " *" : "  ";
    console.log(
      `     ${inRange}${a.date} d=${a.dayNumber} mid=${midNorm.toFixed(1)}h tier=${a.tier} ` +
      `dist=${a.dist} gw=${a.gw.toFixed(3)} tw=${a.totalWeight.toFixed(4)}`
    );
  }
}
