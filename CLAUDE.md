# CLAUDE.md

Client-side React app that visualizes Fitbit sleep data as an actogram with circadian rhythm analysis, designed for people with non-24-hour sleep-wake disorder (N24).

## Commands

```bash
npm run dev       # Dev server at http://localhost:5173 (--host for network access)
npm run build     # TypeScript check (tsc -b) + Vite production build
npm run preview   # Preview production build locally
npm run analyze -- <file.json> [algorithmId] # Run circadian analysis on exported sleep data
npm run analyze-period -- <file.json> [startDate] [endDate] [algorithmId] # Analyze specific date range
npm run split-gaps -- <file.json> # Split file with gaps into separate segment files
npm run compare -- <file.json> [algorithmIds...] # Compare algorithms on the same data
npm run test        # Run all tests once (vitest run)
npm run test:watch  # Watch mode for TDD (vitest)
VERBOSE=1 npx vitest run circadian.groundtruth  # Full diagnostic output for ground truth tests
VIZ=1 npm run test    # Generate HTML actogram visualizations in test-output/
```

ESLint (`eslint.config.js`) and Prettier (`.prettierrc`) are configured. Run `npx eslint <file>` or `npx prettier --check <file>`

## Architecture

- **Client-only SPA** — no backend server, all data stays in browser
- **Single context** — `AppContextDef.ts` defines types + context object; `AppContext.tsx` contains only `AppProvider`; `useAppContext.ts` and `usePersistedState.ts` are in separate files — all split for Vite Fast Refresh compatibility
- **Provider hierarchy** — `main.tsx`: `AuthProvider` → `AppProvider` → `App`
- **Canvas rendering** — actogram and periodogram use HTML Canvas via `useEffect`, not React DOM elements
- **Pure analysis functions** — `analyzeWithAlgorithm()` and `computeLombScargle()` are pure functions called via `useMemo`
- **CLI runner** — `cli/analyze.ts` runs analysis functions directly in Node.js via `tsx`, using `parseSleepData()` from `loadLocalData.ts` to bypass browser `fetch()`

## Key files

| File                                                | Purpose                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/AppContextDef.ts`                              | `ScheduleEntry`, `AppState` interfaces + `AppContext` object (no component, pure defs)        |
| `src/AppContext.tsx`                                | `AppProvider` component only — all state, derived values, viz settings                        |
| `src/useAppContext.ts`                              | `useAppContext()` consumer hook                                                               |
| `src/usePersistedState.ts`                          | `usePersistedState<T>()` hook — localStorage-backed state (used throughout viz settings)      |
| `src/api/types.ts`                                  | `RawSleepRecordV12` (API) and `SleepRecord` (internal) type definitions                       |
| `src/data/useFitbitData.ts`                         | Data orchestrator: cache-first fetch, export, abort                                           |
| `src/data/sleepCache.ts`                            | IndexedDB caching (database: `fitbit-n24-cache`)                                              |
| `src/models/circadian/`                             | Circadian period estimation module (pluggable algorithms)                                     |
| `src/models/circadian/index.ts`                     | Public API: `analyzeWithAlgorithm()`, `DEFAULT_ALGORITHM_ID`, type exports                    |
| `src/models/circadian/types.ts`                     | Base types: `CircadianAnalysis`, `CircadianDay`, `GAP_THRESHOLD_DAYS` (algorithm-independent) |
| `src/models/circadian/registry.ts`                  | Algorithm registry: `registerAlgorithm()`, `getAlgorithm()`, `listAlgorithms()`               |
| `src/models/circadian/segments.ts`                  | Segment splitting for data gaps (`splitIntoSegments`)                                         |
| `src/models/circadian/regression/index.ts`          | Weighted regression algorithm entry point + `_internals` barrel for testing                   |
| `src/models/circadian/regression/__tests__/`        | Regression-specific tests (internals unit tests)                                              |
| `src/models/circadian/regression/types.ts`          | Regression-specific types: `RegressionAnalysis`, `Anchor`, `AnchorPoint`, constants           |
| `src/models/circadian/regression/regression.ts`     | Weighted/robust regression, Gaussian kernel, sliding window evaluation                        |
| `src/models/circadian/regression/unwrap.ts`         | Seed-based phase unwrapping with regression/pairwise branch resolution                        |
| `src/models/circadian/regression/anchors.ts`        | Anchor weight computation, midpoint computation                                               |
| `src/models/circadian/regression/smoothing.ts`      | 3-pass post-hoc overlay smoothing + forecast re-anchoring                                     |
| `src/models/circadian/regression/analyzeSegment.ts` | Per-segment analysis pipeline (steps 1-6 + smoothing call)                                    |
| `src/models/circadian/regression/mergeSegments.ts`  | Merge independently-analyzed segments into single result                                      |
| `src/models/circadian/kalman/index.ts`              | Kalman filter algorithm entry point + `_internals` barrel for testing                         |
| `src/models/circadian/kalman/types.ts`              | Kalman-specific types: `KalmanAnalysis`, `State`, `Cov`, constants                            |
| `src/models/circadian/kalman/filter.ts`             | Forward Kalman filter: predict, update, Mahalanobis gating, 24h ambiguity resolution          |
| `src/models/circadian/kalman/smoother.ts`           | Rauch-Tung-Striebel backward smoother                                                         |
| `src/models/circadian/kalman/observations.ts`       | Sleep record → per-day observation extraction with adaptive measurement noise                 |
| `src/models/circadian/kalman/analyzeSegment.ts`     | Per-segment Kalman pipeline: init → forward filter → RTS smoother → output                    |
| `src/models/circadian/kalman/mergeSegments.ts`      | Merge Kalman segments into single result                                                      |
| `src/models/circadian/csf/index.ts`                 | CSF algorithm entry point + `_internals` barrel for testing                                   |
| `src/models/circadian/csf/types.ts`                 | CSF-specific types: `CSFAnalysis`, `CSFState`, `CSFConfig`, constants                         |
| `src/models/circadian/csf/filter.ts`                | Von Mises filter: predict, update, forwardPass, rtsSmoother                                   |
| `src/models/circadian/csf/anchors.ts`               | Anchor preparation with continuous weight                                                     |
| `src/models/circadian/csf/smoothing.ts`             | Output phase smoothing (`smoothOutputPhase`) + edge correction (`correctEdge`)                |
| `src/models/circadian/csf/analyzeSegment.ts`        | Per-segment CSF pipeline: anchors → filter → smoother → edge correction → output              |
| `src/models/circadian/csf/mergeSegments.ts`         | Merge CSF segments into single result                                                         |
| `src/models/calculateSleepScore.ts`                 | Sleep quality scoring (regression model)                                                      |
| `src/models/lombScargle.ts`                         | Phase coherence periodogram (despite the filename, uses Rayleigh test, not Lomb-Scargle)      |
| `src/models/actogramData.ts`                        | Row building (`buildActogramRows` for calendar, `buildTauRows` for custom period)             |
| `src/models/overlayPath.ts`                         | Manual overlay types (`OverlayControlPoint`, `OverlayDay`) + `interpolateOverlay()`           |
| `src/components/Actogram/useActogramRenderer.ts`    | Canvas rendering engine for the actogram                                                      |
| `src/components/Actogram/useOverlayEditor.ts`       | Interactive overlay editor hook (click/drag/delete control points on canvas)                  |
| `src/models/__tests__/fixtures/visualize.ts`        | Test visualization: `generateVizHtml()`, `maybeSaveViz()` — HTML actograms with VIZ=1         |
| `cli/analyze.ts`                                    | CLI entry point for running analysis in Node.js (debugging harness)                           |

## Conventions

- **Update docs with code** — When adding, removing, or modifying files or public interfaces, update all affected documentation in the same response. Do not defer to a separate step. The documentation files are:
    - `CLAUDE.md` — commands, architecture, key files table, conventions
    - `docs/technical.md` — implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
    - `docs/structure.md` — file listing with per-file descriptions
- **Sleep scores are 0-1**, not 0-100 (stored as `sleepScore` on `SleepRecord`)
- **All timestamps use local time**, not UTC — day boundaries use `Date.setHours(0,0,0,0)` and manual `getFullYear()/getMonth()/getDate()` formatting
- **Viz settings persist** via `usePersistedState` hook (localStorage keys prefixed `viz.`, including `viz.circadianModel`)
- **Algorithm registry** — `CircadianAlgorithm` interface defines `id`, `name`, `description`, `analyze()`; algorithms register via `registerAlgorithm()` at module load; `CircadianAnalysis` is the base result type, `RegressionAnalysis` extends it with algorithm-specific fields (`anchors`, `anchorCount`, etc.)
- **Tailwind CSS v4** — no config file, imported via `@import "tailwindcss"` in `index.css`, processed by `@tailwindcss/vite`
- **No v1 API support** — only v1.2 format records are accepted; legacy v1 throws on import
- **IndexedDB caching** — raw API records cached per-user; incremental fetch only retrieves newer records
- **`RawSleepRecordV12`** is the raw API type; **`SleepRecord`** is the parsed internal type with `Date` objects and computed `sleepScore`
- **Row ordering** — `buildActogramRows` returns rows newest-first; in double-plot, the right half of row `i` shows `rows[i-1]`'s data (the next calendar day)
- **Double-plot layer semantics** — sleep blocks and schedule overlay use next-day data on the right half; circadian overlay duplicates same-day data (tooltip uses `hour % 24` hit-testing)
- **`nightStartHour`/`nightEndHour`** can be negative or >24 (`normalizedMid ± halfDur`); always normalize with `((h % 24) + 24) % 24` before rendering
- **Renderer draw order** — circadian overlay → schedule overlay → sleep blocks → date labels → editor overlay; later layers paint over earlier ones
- **Overlay editor** — distinct edit mode (calendar mode only, disabled in tau mode); control points persist via `usePersistedState`; manual overlay renders in cyan, algorithm overlay dimmed as reference; "Export with overlay" produces ground-truth JSON with both `sleep` and `overlay` arrays
- **Ground-truth test data** — `test-data/` is a gitignored independent git repo; each subdirectory contains `sleep.json` + `overlay.json` pairs; `circadian.groundtruth.test.ts` iterates all pairs and scores algorithm output against manual overlays (skips gracefully if directory missing)
- **Tests** — Vitest, co-located in `__tests__/` dirs next to source; test files excluded from `tsc -b` build via `tsconfig.json` exclude; `_internals` barrel export on `circadian/regression/index.ts` exposes private helpers for unit testing (tree-shaken from production); real data tests use `loadRealData(fileName)` from `fixtures/loadRealData.ts` which loads from `test-data/` by filename (skip gracefully if missing)
- **Test categories** — `correctness:` tests hard-fail on violations (overlay smoothness, drift limits, confidence calibration); `benchmark:` tests log `BENCHMARK` lines with soft targets but only hard-fail on catastrophic guards (very wide bounds), enabling algorithm optimization without false rejections
- **Ground truth output** — compact `GTRESULT` one-liner per dataset by default (machine-parseable for automated optimization); set `VERBOSE=1` env var for full diagnostic ASCII boxes with rolling windows and divergence streaks
- **Hard drift limits** — `localDrift` must be in [-1.5, +3.0] h/day (i.e. `localTau` in [22.5, 27.0]); enforced by `assertHardDriftLimits()` across all tests; `computeDriftPenalty()` scores prolonged periods near limits with superlinear consecutive-day penalty

## Documentation

- `docs/technical.md` — Implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
- `docs/domain.md` — Domain knowledge: N24 disorder, actogram methodology, circadian estimation theory
- `docs/structure.md` — Detailed file listing with per-file descriptions
