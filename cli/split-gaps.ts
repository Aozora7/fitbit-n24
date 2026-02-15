import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, basename, join, extname } from "node:path";
import { parseSleepData } from "../src/data/loadLocalData.js";
import { GAP_THRESHOLD_DAYS } from "../src/models/circadian/types.js";

const file = process.argv[2];
if (!file) {
    console.error("Usage: npx tsx cli/split-gaps.ts <sleep-data.json>");
    process.exit(1);
}

if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(1);
}

const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
const records = parseSleepData(data);

if (records.length === 0) {
    console.error("No sleep records found in file");
    process.exit(1);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface Segment {
    startIdx: number;
    endIdx: number;
    startDate: Date;
    endDate: Date;
}

const segments: Segment[] = [];
let currentSegmentStart = 0;

for (let i = 1; i < records.length; i++) {
    const prevDate = records[i - 1].dateOfSleep;
    const currDate = records[i].dateOfSleep;

    const prevTime = new Date(prevDate).getTime();
    const currTime = new Date(currDate).getTime();
    const gapDays = Math.abs(prevTime - currTime) / MS_PER_DAY;

    if (gapDays > GAP_THRESHOLD_DAYS) {
        segments.push({
            startIdx: currentSegmentStart,
            endIdx: i - 1,
            startDate: new Date(records[currentSegmentStart].dateOfSleep),
            endDate: new Date(records[i - 1].dateOfSleep),
        });
        currentSegmentStart = i;
    }
}

segments.push({
    startIdx: currentSegmentStart,
    endIdx: records.length - 1,
    startDate: new Date(records[currentSegmentStart].dateOfSleep),
    endDate: new Date(records[records.length - 1].dateOfSleep),
});

if (segments.length === 1) {
    console.log(`No gaps > ${GAP_THRESHOLD_DAYS} days found. File remains unsplit.`);
    process.exit(0);
}

console.log(`Found ${segments.length} segments (gap threshold: ${GAP_THRESHOLD_DAYS} days):`);

const dir = dirname(file);
const base = basename(file, extname(file));

for (const segment of segments) {
    const formatDate = (d: Date) => d.toISOString().split("T")[0];
    const startStr = formatDate(segment.startDate);
    const endStr = formatDate(segment.endDate);

    const segmentRecords = records.slice(segment.startIdx, segment.endIdx + 1);
    const outputData = {
        sleep: segmentRecords.map((r) => {
            const raw: Record<string, unknown> = {
                logId: r.logId,
                dateOfSleep: r.dateOfSleep,
                startTime: r.startTime.toISOString(),
                endTime: r.endTime.toISOString(),
                duration: r.durationMs,
                efficiency: r.efficiency,
                minutesAsleep: r.minutesAsleep,
                minutesAwake: r.minutesAwake,
                isMainSleep: r.isMainSleep,
            };
            if (r.stages) raw.stages = r.stages;
            if (r.stageData) raw.levels = { data: r.stageData };
            return raw;
        }),
    };

    const outputFile = join(dir, `${base}_${startStr}_${endStr}.json`);
    writeFileSync(outputFile, JSON.stringify(outputData, null, 2));

    console.log(`  ${startStr} to ${endStr}: ${segmentRecords.length} records -> ${basename(outputFile)}`);
}
