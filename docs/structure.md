# Project structure

```
cli/
  analyze.ts                        CLI entry point: read JSON file, run circadian analysis, print stats

src/
  main.tsx                          Entry point, provider hierarchy (AuthProvider -> AppProvider -> App)
  App.tsx                           Layout shell (no logic, just component composition)
  AppContext.tsx                     Central state: viz settings, derived values, context provider
  index.css                         Tailwind directives + global styles

  api/
    types.ts                        Fitbit API v1.2 types (RawSleepRecordV12) and internal SleepRecord type
    fitbit.ts                       Typed fetch wrapper for Fitbit API (adds Authorization header)
    sleepApi.ts                     Paginated sleep data fetching (fetchAllSleepRecords, fetchNewSleepRecords)

  auth/
    AuthProvider.tsx                OAuth context provider (handles callback, token state)
    oauth.ts                        PKCE implementation (verifier, challenge, token exchange)
    useAuth.ts                      Auth hook exposing token, userId, signIn, signOut

  data/
    loadLocalData.ts                Multi-format JSON import (parseSleepData pure fn + loadLocalData fetch wrapper)
    useSleepData.ts                 Sleep record state hook (set, append, import), parseApiRecords()
    useFitbitData.ts                Orchestrator hook: cache-first fetch, export, abort, clear
    sleepCache.ts                   IndexedDB caching layer (per-user record storage)
    __tests__/
      loadLocalData.test.ts         Parsing all input formats, deduplication, sort order, error handling

  models/
    actogramData.ts                 Actogram row building (buildActogramRows, buildTauRows)
    circadian.ts                    Circadian period estimation (anchor classification, sliding-window robust regression)
    calculateSleepScore.ts          Sleep quality scoring (regression model, 0-1 output)
    lombScargle.ts                  Phase coherence periodogram (windowed weighted Rayleigh test)
    __tests__/
      fixtures/
        synthetic.ts                Seeded synthetic SleepRecord generator (configurable tau, noise, gaps)
        loadRealData.ts             Cached real data loader (skips gracefully if file missing)
      circadian.internals.test.ts   Unit tests for circadian internal helpers (classifyAnchor, regression, unwrapping)
      circadian.integration.test.ts Full pipeline tests (synthetic + real data regression)
      calculateSleepScore.test.ts   Sleep score regression model tests
      lombScargle.test.ts           Periodogram peak detection tests
      actogramData.test.ts          Row building, midnight crossings, tau-mode tests

  components/
    Header.tsx                      App header: record count, circadian stats (tau, drift, shift, avg sleep), privacy modal
    DataToolbar.tsx                  Auth buttons, fetch/stop, import/export, clear cache
    VisualizationControls.tsx        Display toggles (double plot, circadian, periodogram, schedule), color mode, row height/width, forecast
    DateRangeSlider.tsx              Dual-range date filter with year marks
    Periodogram.tsx                  Canvas-based periodogram chart (line plot, significance threshold, peak marker)
    Legend.tsx                       Color legend (stages mode or quality gradient mode)
    ScheduleEditor.tsx               Weekly schedule editor (time inputs, day-of-week toggles)
    Actogram/
      Actogram.tsx                  Main actogram component (canvas + tooltip overlay)
      useActogramRenderer.ts        Canvas rendering engine (sleep blocks, circadian overlay, schedule overlay, grid, labels)
```
