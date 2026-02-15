# CLAUDE.md

Client-side React app that visualizes Fitbit sleep data as an actogram with circadian rhythm analysis, designed for people with non-24-hour sleep-wake disorder (N24).

## Commands

```bash
npm run dev       # Dev server at http://localhost:5173 (--host for network access)
npm run build     # TypeScript check (tsc -b) + Vite production build
npm run preview   # Preview production build locally
npm run analyze -- <file.json> # Run circadian analysis/compare on exported sleep data
npm run analyze-period -- <file.json> [startDate] [endDate] # Analyze specific date range
npm run split-gaps -- <file.json> # Split file with gaps into separate segment files
npm run test        # Run all tests once (vitest run)
npm run test:watch  # Watch mode for TDD (vitest)
```

ESLint (`eslint.config.js`) and Prettier (`.prettierrc`) are configured. Run `npx eslint <file>` or `npx prettier --check <file>`

## Architecture

- **Client-only SPA** — no backend server, all data stays in browser
- **Single context** — `AppContextDef.ts` defines types + context object; `AppContext.tsx` contains only `AppProvider`; `useAppContext.ts` and `usePersistedState.ts` are in separate files — all split for Vite Fast Refresh compatibility
- **Provider hierarchy** — `main.tsx`: `AuthProvider` → `AppProvider` → `App`
- **Canvas rendering** — actogram and periodogram use HTML Canvas via `useEffect`, not React DOM elements
- **Pure analysis functions** — `analyzeCircadian()` and `computeLombScargle()` are pure functions called via `useMemo`
- **CLI runner** — `cli/analyze.ts` runs analysis functions directly in Node.js via `tsx`, using `parseSleepData()` from `loadLocalData.ts` to bypass browser `fetch()`

## Key files

| File                                             | Purpose                                                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `src/AppContextDef.ts`                           | `ScheduleEntry`, `AppState` interfaces + `AppContext` object (no component, pure defs)   |
| `src/AppContext.tsx`                             | `AppProvider` component only — all state, derived values, viz settings                   |
| `src/useAppContext.ts`                           | `useAppContext()` consumer hook                                                          |
| `src/usePersistedState.ts`                       | `usePersistedState<T>()` hook — localStorage-backed state (used throughout viz settings) |
| `src/api/types.ts`                               | `RawSleepRecordV12` (API) and `SleepRecord` (internal) type definitions                  |
| `src/data/useFitbitData.ts`                      | Data orchestrator: cache-first fetch, export, abort                                      |
| `src/data/sleepCache.ts`                         | IndexedDB caching (database: `fitbit-n24-cache`)                                         |
| `src/models/circadian/`                          | Circadian period estimation module (the core algorithm)                                  |
| `src/models/circadian/index.ts`                  | `analyzeCircadian()` orchestrator + public re-exports + `_internals` barrel              |
| `src/models/circadian/types.ts`                  | All interfaces, type aliases, and constants                                              |
| `src/models/circadian/regression.ts`             | Weighted/robust regression, Gaussian kernel, sliding window evaluation                   |
| `src/models/circadian/unwrap.ts`                 | Seed-based phase unwrapping with regression/pairwise branch resolution                   |
| `src/models/circadian/anchors.ts`                | Anchor classification, midpoint computation, segment splitting                           |
| `src/models/circadian/smoothing.ts`              | 3-pass post-hoc overlay smoothing + forecast re-anchoring                                |
| `src/models/circadian/analyzeSegment.ts`         | Per-segment analysis pipeline (steps 1-6 + smoothing call)                               |
| `src/models/circadian/mergeSegments.ts`          | Merge independently-analyzed segments into single result                                 |
| `src/models/calculateSleepScore.ts`              | Sleep quality scoring (regression model)                                                 |
| `src/models/lombScargle.ts`                      | Phase coherence periodogram (despite the filename, uses Rayleigh test, not Lomb-Scargle) |
| `src/models/actogramData.ts`                     | Row building (`buildActogramRows` for calendar, `buildTauRows` for custom period)        |
| `src/models/overlayPath.ts`                      | Manual overlay types (`OverlayControlPoint`, `OverlayDay`) + `interpolateOverlay()`      |
| `src/components/Actogram/useActogramRenderer.ts` | Canvas rendering engine for the actogram                                                 |
| `src/components/Actogram/useOverlayEditor.ts`    | Interactive overlay editor hook (click/drag/delete control points on canvas)             |
| `cli/analyze.ts`                                 | CLI entry point for running analysis in Node.js (debugging harness)                      |

## Conventions

- **Update docs with code** — When adding, removing, or modifying files or public interfaces, update all affected documentation in the same response. Do not defer to a separate step. The documentation files are:
    - `CLAUDE.md` — commands, architecture, key files table, conventions
    - `docs/technical.md` — implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
    - `docs/structure.md` — file listing with per-file descriptions
- **Sleep scores are 0-1**, not 0-100 (stored as `sleepScore` on `SleepRecord`)
- **All timestamps use local time**, not UTC — day boundaries use `Date.setHours(0,0,0,0)` and manual `getFullYear()/getMonth()/getDate()` formatting
- **Viz settings persist** via `usePersistedState` hook (localStorage keys prefixed `viz.`, including `viz.circadianModel`)
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
- **Tests** — Vitest, co-located in `__tests__/` dirs next to source; test files excluded from `tsc -b` build via `tsconfig.json` exclude; `_internals` barrel export on `circadian/index.ts` exposes private helpers for unit testing (tree-shaken from production); real data tests skip gracefully if `public/dev-data/auto-import.json` is missing

## Documentation

- `docs/technical.md` — Implementation details, data flow, algorithm descriptions, algorithm parameters, test coverage
- `docs/domain.md` — Domain knowledge: N24 disorder, actogram methodology, circadian estimation theory
- `docs/structure.md` — Detailed file listing with per-file descriptions
