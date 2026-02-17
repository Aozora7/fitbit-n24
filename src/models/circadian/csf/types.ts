import type { CircadianAnalysis } from "../types";
import type { SleepRecord } from "../../../api/types";

export interface CSFState {
    phase: number;
    tau: number;
    phaseVar: number;
    tauVar: number;
    cov: number;
}

export interface CSFConfig {
    processNoisePhase: number;
    processNoiseTau: number;
    measurementKappaBase: number;
    tauPrior: number;
    tauPriorVar: number;
    maxCorrectionPerStep: number;
}

export interface CSFAnchor {
    dayNumber: number;
    midpointHour: number;
    weight: number;
    record: SleepRecord;
}

export interface CSFAnalysis extends CircadianAnalysis {
    states: CSFState[];
    algorithmId: "csf-v1";
    anchorCount: number;
}

export interface SmoothedState extends CSFState {
    smoothedPhase: number;
    smoothedTau: number;
    smoothedPhaseVar: number;
    smoothedTauVar: number;
}

export interface SegmentResult {
    days: import("../types").CircadianDay[];
    states: SmoothedState[];
    anchors: CSFAnchor[];
    anchorCount: number;
    residuals: number[];
    segFirstDay: number;
    segLastDay: number;
}

export const DEFAULT_CONFIG: CSFConfig = {
    processNoisePhase: 0.08,
    processNoiseTau: 0.001,
    measurementKappaBase: 0.35,
    tauPrior: 25.0,
    tauPriorVar: 0.1,
    maxCorrectionPerStep: 4.0,
};

export const MIN_ANCHORS = 2;
export const TAU_MIN = 22.0;
export const TAU_MAX = 27.0;
