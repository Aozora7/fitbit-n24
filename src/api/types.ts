// ─── Fitbit Sleep API v1.2 (stages) ────────────────────────────────

export type SleepStageLevel = "wake" | "light" | "deep" | "rem";

export interface SleepLevelEntry {
  dateTime: string; // ISO datetime
  level: SleepStageLevel;
  seconds: number;
}

export interface SleepStageSummaryEntry {
  count: number;
  minutes: number;
  thirtyDayAvgMinutes: number;
}

export interface SleepStageSummary {
  deep: SleepStageSummaryEntry;
  light: SleepStageSummaryEntry;
  rem: SleepStageSummaryEntry;
  wake: SleepStageSummaryEntry;
}

export interface SleepLevels {
  data: SleepLevelEntry[];
  shortData: SleepLevelEntry[];
  summary: SleepStageSummary;
}

export interface RawSleepRecordV12 {
  dateOfSleep: string;
  duration: number;
  efficiency: number;
  startTime: string;
  endTime: string;
  infoCode: number;
  isMainSleep: boolean;
  levels: SleepLevels;
  logId: number;
  logType: string;
  minutesAfterWakeup: number;
  minutesAsleep: number;
  minutesAwake: number;
  minutesToFallAsleep: number;
  timeInBed: number;
  type: "stages" | "classic";
}

// ─── Raw API response shapes ───────────────────────────────────────

/** v1.2 format: single page with sleep array + pagination */
export interface FitbitSleepPageV12 {
  sleep: RawSleepRecordV12[];
  pagination?: {
    beforeDate?: string;
    afterDate?: string;
    limit?: number;
    next?: string;
    offset?: number;
    previous?: string;
    sort?: string;
  };
}

// ─── Unified internal types ────────────────────────────────────────

export interface SleepStages {
  deep: number; // minutes
  light: number;
  rem: number;
  wake: number;
}

/** Processed sleep record used throughout the app */
export interface SleepRecord {
  logId: number;
  dateOfSleep: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  durationHours: number;
  efficiency: number;
  minutesAsleep: number;
  minutesAwake: number;
  isMainSleep: boolean;
  sleepScore: number;

  /** v1.2 stage summary (present when original type === "stages") */
  stages?: SleepStages;
  /** v1.2 per-interval stage data for rendering (present when original has levels) */
  stageData?: SleepLevelEntry[];
}
