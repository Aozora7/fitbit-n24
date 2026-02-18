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
GT_MODE=verbose npm run test -- circadian.groundtruth  # Full diagnostic output for ground truth tests
GT_MODE=json npm run test -- circadian.groundtruth    # JSON output for programmatic use
GT_MODE=compare npm run test -- circadian.groundtruth # Compare current vs recorded baselines
UPDATE_BASELINE=1 npm run test -- circadian.groundtruth # Save current results as baselines
```

ESLint (`eslint.config.js`) and Prettier (`.prettierrc`) are configured. Run `npx eslint <file>` or `npx prettier --check <file>`

## Architecture

- **Client-only SPA** — no backend server, all data stays in browser
- **Single context** — `AppContextDef.ts` defines types + context object; `AppContext.tsx` contains only `AppProvider`; `useAppContext.ts` and `usePersistedState.ts` are in separate files — all split for Vite Fast Refresh compatibility
- **Provider hierarchy** — `main.tsx`: `AuthProvider` → `AppProvider` → `App`
- **Canvas rendering** — actogram and periodogram use HTML Canvas via `useEffect`, not React DOM elements
- **Pure analysis functions** — `analyzeWithAlgorithm()` and `computePeriodogram()` are pure functions called via `useMemo`
- **CLI runner** — `cli/analyze.ts` runs analysis functions directly in Node.js via `tsx`, using `parseSleepData()` from `loadLocalData.ts` to bypass browser `fetch()`

## Key files

| File                                             | Purpose                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `src/AppContextDef.ts`                           | `ScheduleEntry`, `AppState` interfaces + `AppContext` object (no component)           |
| `src/AppContext.tsx`                             | `AppProvider` component — all state, derived values, viz settings                     |
| `src/api/types.ts`                               | `RawSleepRecordV12` (API) and `SleepRecord` (internal) type definitions               |
| `src/data/useFitbitData.ts`                      | Data orchestrator: cache-first fetch, export, abort                                   |
| `src/models/circadian/`                          | Circadian period estimation module (pluggable algorithms)                             |
| `src/models/circadian/index.ts`                  | Public API: `analyzeWithAlgorithm()`, `DEFAULT_ALGORITHM_ID`, type exports            |
| `src/models/circadian/types.ts`                  | Base types: `CircadianAnalysis`, `CircadianDay`, `GAP_THRESHOLD_DAYS`                 |
| `src/models/circadian/registry.ts`               | Algorithm registry: `registerAlgorithm()`, `getAlgorithm()`, `listAlgorithms()`       |
| `src/models/circadian/csf/index.ts`              | Circular state-space filter algorithm — see module header for file structure          |
| `src/models/periodogram.ts`                      | Phase coherence periodogram (windowed weighted Rayleigh test)                         |
| `src/models/actogramData.ts`                     | Row building (`buildActogramRows` for calendar, `buildTauRows` for custom period)     |
| `src/models/overlayPath.ts`                      | Manual overlay types (`OverlayControlPoint`, `OverlayDay`) + `interpolateOverlay()`   |
| `src/utils/exportPNG.ts`                         | PNG export: composites actogram + periodogram + header/legend into downloadable image |
| `src/components/DataToolbar.tsx`                 | Auth buttons, fetch/stop, import/export, PNG save, overlay export (icon+text buttons) |
| `src/components/VisualizationControls.tsx`       | Display toggles, algorithm selector, color mode, row height/width, forecast controls  |
| `src/components/Actogram/useActogramRenderer.ts` | Canvas rendering engine for the actogram                                              |
| `src/components/Actogram/useOverlayEditor.ts`    | Interactive overlay editor hook (click/drag/delete control points)                    |
| `cli/analyze.ts`                                 | CLI entry point for running analysis in Node.js                                       |

## Conventions

- **Update docs with code** — When adding, removing, or modifying files or public interfaces, update all affected documentation in the same response. Do not defer to a separate step. The documentation files are:
    - `CLAUDE.md` — commands, architecture, key files table, conventions
    - `docs/technical.md` — implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
    - `docs/structure.md` — file listing with per-file descriptions
- **All timestamps use local time**, not UTC — day boundaries use `Date.setHours(0,0,0,0)` and manual `getFullYear()/getMonth()/getDate()` formatting
- **Viz settings persist** via `usePersistedState` hook (localStorage keys prefixed `viz.`, including `viz.circadianModel`)
- **Algorithm registry** — `CircadianAlgorithm` interface defines `id`, `name`, `description`, `analyze()`; algorithms register via `registerAlgorithm()` at module load
- **IndexedDB caching** — raw API records cached per-user; incremental fetch only retrieves newer records
- **`RawSleepRecordV12`** is the raw API type; **`SleepRecord`** is the parsed internal type with `Date` objects and computed `sleepScore`
- **Row ordering** — `buildActogramRows` returns rows newest-first by default (pass `sortDirection: "oldest"` for oldest-first); double-plot uses next-day data (row `i-1` for newest-first, row `i+1` for oldest-first)
- **Double-plot layer semantics** — sleep blocks and schedule overlay use next-day data on the right half; circadian overlay duplicates same-day data (tooltip uses `hour % 24` hit-testing)
- **`nightStartHour`/`nightEndHour`** can be negative or >24 (`normalizedMid ± halfDur`); always normalize with `((h % 24) + 24) % 24` before rendering
- **Renderer draw order** — circadian overlay → schedule overlay → sleep blocks → date labels → editor overlay; later layers paint over earlier ones
- **Overlay editor** — distinct edit mode (calendar mode only, disabled in tau mode); control points persist via `usePersistedState`; manual overlay renders in cyan, algorithm overlay dimmed as reference; "Export with overlay" produces ground-truth JSON with both `sleep` and `overlay` arrays
- **Ground-truth test data** — `test-data/` is a gitignored independent git repo; each subdirectory contains `sleep.json` + `overlay.json` pairs; `circadian.groundtruth.test.ts` iterates all pairs and scores algorithm output against manual overlays (skips gracefully if directory missing)
- **Tests** — Vitest, co-located in `__tests__/` dirs next to source; test files excluded from `tsc -b` build via `tsconfig.json` exclude; `_internals` barrel export exposes private helpers for unit testing (tree-shaken from production)
- **Test categories** — `correctness:` tests hard-fail on violations; `benchmark:` tests log `BENCHMARK` lines with soft targets but only hard-fail on catastrophic guards
- **Hard drift limits** — `localDrift` must be in [-1.5, +3.0] h/day (i.e. `localTau` in [22.5, 27.0]); enforced by `assertHardDriftLimits()` across all tests
- **This is a TypeScript ESM project.** — Do not use CommonJS patterns (require, module.exports). Hook scripts and config files that need CommonJS must use .cjs extension.
- **Do not use names or contents of test datasets in documentation or tests.**

## Documentation

- `docs/technical.md` — Implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
- `docs/domain.md` — Domain knowledge: N24 disorder, actogram methodology, circadian estimation theory
- `docs/structure.md` — Detailed file listing with per-file descriptions
