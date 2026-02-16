# Project structure

```
cli/
  analyze.ts                        CLI entry point: read JSON file, run circadian analysis, print stats
  analyze_period.ts                 Diagnostic script for analyzing a specific date range in a JSON file
  compare.ts                        Compare multiple circadian algorithms on the same dataset

src/
  main.tsx                          Entry point, provider hierarchy (AuthProvider -> AppProvider -> App)
  App.tsx                           Layout shell (no logic, just component composition)
  AppContextDef.ts                   ScheduleEntry + AppState interfaces, AppContext createContext object (no component)
  AppContext.tsx                     AppProvider component only: all state, derived values, viz settings wired to context
  useAppContext.ts                   useAppContext() consumer hook (reads AppContext)
  usePersistedState.ts               usePersistedState<T>() hook — localStorage-backed state (viz.* keys)
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
    overlayPath.ts                  Manual overlay types (OverlayControlPoint, OverlayDay) + interpolateOverlay()
    circadian/
      index.ts                     Public API: analyzeCircadian(), analyzeWithAlgorithm(), type exports
      types.ts                     Base types: CircadianAnalysis, CircadianDay, GAP_THRESHOLD_DAYS (algorithm-independent)
      registry.ts                  Algorithm registry: registerAlgorithm(), getAlgorithm(), listAlgorithms()
      segments.ts                  Segment splitting for data gaps (splitIntoSegments)
      regression/
        index.ts                   Algorithm entry point: analyzeCircadian(), _internals barrel for testing
        types.ts                   Regression-specific types: RegressionAnalysis, Anchor, AnchorPoint, constants
        regression.ts              Weighted/robust regression (IRLS+Tukey), Gaussian kernel, sliding window
        unwrap.ts                  Seed-based phase unwrapping with regression/pairwise branch resolution
        anchors.ts                 Anchor classification, midpoint computation
        smoothing.ts               3-pass post-hoc overlay smoothing + forecast re-anchoring
        analyzeSegment.ts          Per-segment analysis pipeline
        mergeSegments.ts           Merge independently-analyzed segments into single result
      kalman/
        index.ts                   Kalman filter algorithm entry point + _internals barrel for testing
        types.ts                   Kalman-specific types: KalmanAnalysis, State, Cov, algorithm constants
        filter.ts                  Forward Kalman filter: predict(), update(), gate(), resolveAmbiguity()
        smoother.ts                Rauch-Tung-Striebel backward smoother (single optimal backward pass)
        observations.ts            Sleep record → per-day observation extraction with adaptive measurement noise
        analyzeSegment.ts          Per-segment pipeline: initialization, forward filter, RTS smoother, output
        mergeSegments.ts           Merge Kalman segments into single KalmanAnalysis result
      csf/
        index.ts                   CSF algorithm entry point + _internals barrel for testing
        types.ts                   CSF-specific types: CSFAnalysis, CSFState, CSFConfig, algorithm constants
        filter.ts                  Von Mises filter: predict(), update(), forwardPass(), rtsSmoother()
        anchors.ts                 Anchor preparation (reuse regression tier classification)
        analyzeSegment.ts          Per-segment pipeline: anchors, filter, smoother, output
        mergeSegments.ts           Merge CSF segments into single CSFAnalysis result
    calculateSleepScore.ts          Sleep quality scoring (regression model, 0-1 output)
    lombScargle.ts                  Phase coherence periodogram (windowed weighted Rayleigh test) + buildPeriodogramAnchors()
    __tests__/
      fixtures/
        synthetic.ts                Seeded synthetic SleepRecord generator (configurable tau, noise, gaps)
        loadRealData.ts             Generic real data loader: `loadRealData(fileName)` loads from test-data/, `hasRealData(fileName)` checks existence
        loadGroundTruth.ts          Ground-truth dataset loader (iterates test-data/ subdirs, loads sleep+overlay pairs)
        driftPenalty.ts             Hard drift limit assertions + penalty scoring for prolonged extreme drift
      circadian.internals.test.ts   Unit tests for circadian internal helpers (classifyAnchor, regression, unwrapping)
      circadian.integration.test.ts Full pipeline tests (synthetic + real data regression)
      circadian.scoring.test.ts   Benchmark + correctness tests (tau sweep, phase accuracy, noise/gap/outlier degradation, overlay smoothness, drift limits)
      circadian.groundtruth.test.ts Ground-truth overlay scoring (compact GTRESULT format by default, VERBOSE=1 for full diagnostics)
      overlayPath.test.ts           Overlay interpolation tests (linear interp, phase wrapping, extrapolation)
      calculateSleepScore.test.ts   Sleep score regression model tests
      lombScargle.test.ts           Periodogram peak detection tests
      actogramData.test.ts          Row building, midnight crossings, tau-mode tests

  components/
    Header.tsx                      App header: record count, circadian stats (tau, drift, shift, avg sleep), privacy modal
    DataToolbar.tsx                  Auth buttons, fetch/stop, import/export, clear cache
    VisualizationControls.tsx        Display toggles (double plot, circadian, periodogram, schedule), algorithm selector, color mode, row height/width, forecast
    DateRangeSlider.tsx              Dual-range date filter with year marks
    Periodogram.tsx                  Canvas-based periodogram chart (line plot, significance threshold, peak marker)
    Legend.tsx                       Color legend (stages mode or quality gradient mode)
    ScheduleEditor.tsx               Weekly schedule editor (time inputs, day-of-week toggles)
    Actogram/
      Actogram.tsx                  Main actogram component (canvas + tooltip overlay + editor wiring)
      useActogramRenderer.ts        Canvas rendering engine (sleep blocks, circadian overlay, manual overlay, schedule overlay, grid, labels, editor layer)
      useOverlayEditor.ts           Interactive overlay editor hook (click/drag/delete control points, gutter handles, path line)
```
