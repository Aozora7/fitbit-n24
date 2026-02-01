import type { SleepRecord } from "../api/types";

export function computeQualityScore(record: SleepRecord): number {
    const GOAL_MINUTES = 480; //8 hours
    const hasStages = record?.stages?.deep && record?.stages?.rem;

    if (hasStages) {
        // DETAILED CALCULATION (Main Sleep)
        // DURATION SCORE (Max 50): linear from zero to maximum at goal.
        const durationScore = Math.min(50, (record.minutesAsleep / GOAL_MINUTES) * 50);

        const stages = record.stages!;
        const totalRecordedMinutes = stages.deep + stages.light + stages.rem + stages.wake;

        if (totalRecordedMinutes === 0) {
            return 0;
        }
        // COMPOSITION/QUALITY SCORE (Max 25)
        // Benchmark: Combined Deep + REM should ideally be ~40-50% of total sleep.
        // We set 40% (0.4) as the benchmark for max points.
        const restorativeMinutes = stages.deep + stages.rem;
        const restorativeRatio = restorativeMinutes / record.minutesAsleep;
        const compositionScore = Math.min(25, (restorativeRatio / 0.4) * 25);

        // RESTORATION SCORE (Max 25) - PROXY
        // Note: Official algorithm uses Sleeping HR vs RHR here.
        // Proxy: We use 'efficiency' and 'minutesAwake' to approximate restlessness.
        // Benchmark: 90% efficiency is considered excellent.
        let restorationScore = 0;
        if (record.efficiency >= 90) {
            restorationScore = 25;
        } else {
            // Using range between 60 and 90, awarding 0 for 60 and maximum for 90.
            restorationScore = (Math.max(record.efficiency - 60, 0) / 30) * 25;
        }
        return Math.round(durationScore + compositionScore + restorationScore) / 100;
    } else {
        // FALLBACK CALCULATION (Naps / No Stages)
        // Without stages, we only have Duration and Efficiency.
        // Duration part (Max 70)
        const simpleDurationScore = Math.min(60, (record.minutesAsleep / GOAL_MINUTES) * 70);

        // Efficiency part (Max 30)
        // If efficiency >= 90, max points. Else scaled.
        const simpleEfficiencyScore = record.efficiency >= 90 ? 40 : (record.efficiency / 90) * 30;

        return Math.round(simpleDurationScore + simpleEfficiencyScore) / 100;
    }
}
