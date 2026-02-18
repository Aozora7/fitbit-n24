# Technical implementation

## Architecture

The app follows a unidirectional data flow with two data paths — fetching from the Fitbit API and importing from local JSON files:

```
Fitbit API (v1.2)                        Local JSON file
  -> sleepApi.ts                           -> loadLocalData.ts
     (paginated fetch,                        (auto-detect v1.2/exported format,
      progressive callback)                    parse, sort, deduplicate)
  -> parseApiRecords()                              |
     (RawSleepRecordV12 -> SleepRecord              |
      via calculateSleepScore)                      |
  -> appendRecords() per page                       |
            |                                       |
            v                                       v
      useFitbitData.ts (orchestrator hook)
        - Phase 1: Load from IndexedDB cache (sleepCache.ts)
        - Phase 2: Incremental fetch from API (only records after latest cached date)
        - Persists new records to IndexedDB after fetch
            |
            v
        SleepRecord[] (useSleepData hook state)
            |
            +---> buildActogramRows()  (one row per calendar day or per tau-length window)
            |       -> ActogramRow[]
            |       -> useActogramRenderer() (Canvas drawing)
            |
            +---> analyzeWithAlgorithm()  (pluggable algorithms: regression, Kalman, CSF)
            |       -> CircadianAnalysis { days: CircadianDay[], globalTau, ... }
            |       -> useActogramRenderer() (purple/amber overlay band with variable alpha)
            |
            +---> computePeriodogram()  (windowed phase coherence periodogram)
                    -> PeriodogramResult { points, peakPeriod, significanceThreshold, ... }
                    -> Periodogram.tsx (Canvas chart)
```

All computation happens in `useMemo` hooks inside `AppContext.tsx`. The actogram rows and circadian analysis are recomputed when the underlying records or filter range change. During a fetch, records accumulate incrementally and the visualization updates after each API page.

## Data formats

### Fitbit API v1.2 (stages)

The app only supports v1.2 format records. These include sleep stage data:

- `levels.data[]`: array of `{ dateTime, level, seconds }` where level is `"deep"`, `"light"`, `"rem"`, or `"wake"`
- `levels.summary`: `{ deep: { minutes, count }, light: {...}, rem: {...}, wake: {...} }`
- `type`: `"stages"` (has full stage data) or `"classic"` (old format wrapped in v1.2 structure — has `levels.data` with `asleep`/`restless`/`awake` levels but no stage summary)
- `isMainSleep`: boolean distinguishing primary sleep from naps

The classic-type records in v1.2 have `levels.summary` with `asleep`/`restless`/`awake` keys instead of `deep`/`light`/`rem`/`wake`. The parser checks for the presence of stage keys before accessing them to handle both shapes safely.

### Unified SleepRecord

v1.2 records are parsed into a common `SleepRecord` type:

- `logId`: number
- `dateOfSleep`: string (YYYY-MM-DD)
- `startTime` / `endTime`: `Date` objects
- `durationMs` / `durationHours`: computed from `duration`
- `efficiency`: 0-100
- `minutesAsleep` / `minutesAwake`: number
- `isMainSleep`: boolean
- `sleepScore`: number (0-1), computed by `calculateSleepScore()`
- `stages?`: `{ deep, light, rem, wake }` in minutes (only for v1.2 stages type)
- `stageData?`: `SleepLevelEntry[]` for per-interval rendering (v1.2)

### Export format

The app exports raw API records wrapped in `{ "sleep": [...] }` when data was fetched from the API. This round-trips cleanly with import since it's the standard v1.2 API response shape. When exporting data that was imported (no raw API records available), the internal `SleepRecord` format is used, distinguished on re-import by the presence of `durationMs` instead of `duration`.

## Data loading

### `loadLocalData.ts`

Exposes two functions:

- **`parseSleepData(data: unknown): SleepRecord[]`** — Pure function (no browser APIs) that takes a JSON-parsed value, detects its format, parses records, sorts by `startTime` ascending, and deduplicates by `logId`. Used by both the browser app and the Node.js CLI.
- **`loadLocalData(url: string): Promise<SleepRecord[]>`** — Thin browser wrapper that calls `fetch(url)`, parses JSON, and delegates to `parseSleepData()`.

Auto-detects multiple JSON structures:

1. **Single API page**: `{ "sleep": [...] }`
2. **Array of API pages**: `[ { "sleep": [...] }, ... ]`
3. **Flat array of records**: `[ { "dateOfSleep": "...", ... }, ... ]`

For each record, format detection:

- `"durationMs"` present → internal exported format (re-hydrate Date objects)
- `"levels"` or `"type"` present → v1.2 API format
- Otherwise → error (v1 format is not supported)

### `useSleepData.ts`

React hook managing the records state with three mutation paths:

- `setRecords(recs)`: Replace all records (sort + dedup)
- `appendRecords(newRecs)`: Merge new records into existing set (for progressive loading)
- `importFromFiles(files)`: Load records from one or more JSON files, merging all into one dataset (single transaction)

### `useFitbitData.ts`

Orchestrator hook that wraps `useSleepData` with fetch lifecycle, caching, and export:

- `startFetch(token, userId)`: Two-phase fetch — load IndexedDB cache first, then fetch only records newer than the latest cached date via `fetchNewSleepRecords()`. Falls back to full fetch via `fetchAllSleepRecords()` if no cache exists.
- `stopFetch()`: Aborts the current fetch via `AbortController`, keeping already-fetched data.
- `importFromFiles(files)`: Load records from one or more JSON files, merging all into one dataset.
- `exportToFile()`: Downloads raw API records (or internal records if imported) as JSON.
- `clearCache(userId)`: Clears IndexedDB and in-memory state.
- `reset()`: Clears in-memory state only (used on sign-out).

Newly fetched records are persisted to IndexedDB in the `finally` block after fetch completes or aborts.

## IndexedDB caching (`sleepCache.ts`)

The app caches raw API records in IndexedDB for fast reload:

- Database: `"fitbit-n24-cache"` (version 1)
- Object store: `"sleepRecords"` with keyPath `"logId"`
- Compound index: `["_userId", "dateOfSleep"]` for per-user queries
- Functions:
    - `getCachedRecords(userId)`: Returns all cached records for a user
    - `getLatestDateOfSleep(userId)`: Returns the most recent `dateOfSleep` in the cache (used for incremental fetch)
    - `putRecords(userId, records)`: Writes records to the store (stamps each with `_userId`)
    - `clearUserCache(userId)`: Deletes all records for a user
- Gracefully degrades if IndexedDB is unavailable (returns empty results, logs warnings)

## Authentication

### OAuth 2.0 PKCE flow (`auth/oauth.ts`)

The app uses Authorization Code with PKCE (no client secret):

1. `generateVerifier()`: 128 random characters from `crypto.getRandomValues`
2. `computeChallenge()`: SHA-256 hash via Web Crypto API, base64url-encoded
3. `startAuth()`: Stores verifier in `sessionStorage`, redirects to Fitbit authorize endpoint with `code_challenge`
4. After redirect back, `AuthProvider` extracts `?code=` from the URL
5. `exchangeCode()`: POSTs to Fitbit token endpoint with the verifier and client ID

Tokens are stored in `sessionStorage` (cleared when the tab closes). The client ID is read from `VITE_FITBIT_CLIENT_ID` environment variable — if not set, auth UI is hidden.

### API fetching (`api/sleepApi.ts`)

Two fetch functions:

- `fetchAllSleepRecords()`: Paginates through the v1.2 sleep list endpoint starting from tomorrow's date. Fetches 100 records per page, following `pagination.next` cursors. Calls `onPageData(pageRecords, totalSoFar, page)` after each page.
- `fetchNewSleepRecords()`: Incremental fetch using an `afterDate` parameter to only retrieve records newer than the latest cached date.

Both accept an `AbortSignal` for cancellation.

## Actogram data transform

`buildActogramRows()` in `models/actogramData.ts`:

1. Finds the date range from the earliest `startTime` to the latest `endTime`
2. Creates one `ActogramRow` per calendar day using **local** date formatting (`toLocalDateStr`) to avoid UTC/local timezone mismatches
3. For each sleep record, iterates calendar days it overlaps (using `localMidnight` for correct day boundaries)
4. Clips the record's time range to each day's `[0, 24)` hour window
5. Stores the clipped block with `startHour`/`endHour` (fractional hours from local midnight) and a reference to the original `SleepRecord`
6. Reverses the array so newest days come first

A sleep record from 23:00 to 07:00 produces two blocks: one on day 1 covering `[23, 24)` and one on day 2 covering `[0, 7)`.

`buildTauRows()` creates rows of custom length (e.g. 24.5h) instead of calendar days, producing a `startMs` field on each row for absolute time positioning.

**Timezone handling**: All day boundaries use local time via `Date.setHours(0,0,0,0)` and manual `getFullYear()/getMonth()/getDate()` formatting. Earlier versions used `toISOString().slice(0,10)` which caused UTC conversion bugs for non-UTC timezones.

## Canvas rendering

`useActogramRenderer.ts` draws everything in a single `useEffect` that runs when rows, circadian data, or config changes.

### Coordinate system

- Y axis: each row is `rowHeight` CSS pixels tall, starting at `topMargin`
- X axis: `d3-scale`'s `scaleLinear` maps `[0, hoursPerRow]` to `[leftMargin, canvasWidth - rightMargin]`, where `hoursPerRow` is `baseHours` (24 or custom tau) doubled if in double-plot mode
- The canvas is sized at `devicePixelRatio` scale for sharp rendering, then drawn in CSS pixel coordinates after a `ctx.scale(dpr, dpr)` call
- In tau mode, left margin is widened to 110px to accommodate `YYYY-MM-DD HH:mm` labels

### Drawing order

1. Background fill
2. Hour grid lines (every 6 hours)
3. Hour labels at top (absolute hours in calendar mode, relative `+0, +6, ...` offsets in tau mode)
4. Circadian overlay (purple for historical, amber for forecast; alpha = `0.1 + confidenceScore * 0.25`)
5. Schedule overlay (green semi-transparent blocks, `rgba(34, 197, 94, 0.2)`)
6. Sleep blocks (stage coloring, quality coloring, or solid fallback)
7. Date labels on left margin (every row at large heights, every 7th row at small heights)
8. Editor overlay — control point handles and connecting path line (only in edit mode)

### Sleep block rendering

Three rendering paths based on color mode and data availability:

1. **Quality mode**: Solid color based on `sleepScore`, mapped through a red→yellow→green HSL gradient (hue 0°→120°, scaled from score range 0.5–1.0).

2. **Stage data** (block > 5px wide): `drawStageBlock()` renders each `SleepLevelEntry` as a colored rectangle. Stage entry times are mapped to x-axis coordinates by computing absolute time boundaries for the block and linearly mapping entry positions. Supports both calendar mode (reconstructs midnight from record start) and tau mode (uses `row.startMs`).

3. **Solid fallback**: A single light blue rectangle for blocks too narrow for stage detail or records without stage data.

### Stage colors

| Stage | Color     | Hex       |
| ----- | --------- | --------- |
| Deep  | Dark blue | `#1e40af` |
| Light | Blue      | `#60a5fa` |
| REM   | Cyan      | `#06b6d4` |
| Wake  | Red       | `#ef4444` |

### Double-plot mode

In double-plot mode, each row displays 48 hours: the left half shows day D (hours 0–24) and the right half shows day D+1 (hours 24–48). Rows are ordered newest-first, so for row index `i`, `rows[i-1]` is the next calendar day.

**Sleep blocks**: The left half draws the current row's blocks at their normal positions. The right half draws `rows[i-1]`'s blocks shifted by `baseHours`. This means each day's data appears twice — on the right half of the previous row and the left half of its own row — creating visual continuity for sleep records that cross midnight.

**Schedule overlay**: Same next-day logic as sleep blocks. The right half draws the schedule entries for `rows[i-1]`'s calendar date (which may be a different day of the week with different schedule entries).

**Circadian overlay**: Duplicates the same day's prediction on both halves (does NOT use next-day data). This matches the tooltip's `hour % 24` hit-testing, which checks the current row's circadian data regardless of which half is hovered. The circadian night is a per-day estimate, and duplicating it maintains consistency between the visual overlay position and the tooltip.

**Tooltip**: Sleep block hit-testing checks both the current row's blocks (offset 0) and `rows[rowIdx-1]`'s blocks (offset `baseHours`), returning the source row's date in the tooltip. Circadian hit-testing normalizes the cursor hour with `hour % 24` and checks against the current row's circadian data only.

The topmost row (`i = 0`) has no right-half data for sleep/schedule since there is no `rows[-1]`.

### Tau mode

When the row width is set to a custom period (e.g. 24.5h), rows are built by `buildTauRows()` instead of `buildActogramRows()`. Each row has a `startMs` timestamp used for absolute positioning of sleep blocks, circadian overlay, and schedule overlay. Hour labels show relative offsets (`+0`, `+6`, ...) instead of clock times.

## Circadian period estimation

The circadian analysis module supports pluggable algorithms via a registry system. The default algorithm (`regression-v1`) is implemented in `models/circadian/regression/` and uses a multi-stage pipeline. The module is organized into algorithm-independent code at the top level (`types.ts`, `registry.ts`, `index.ts`) and algorithm-specific code in subdirectories.

### Algorithm registry

Algorithms implement the `CircadianAlgorithm` interface with `id`, `name`, `description`, and `analyze()` method. They register via `registerAlgorithm()` at module load time. The public API provides:

- `analyzeWithAlgorithm(algorithmId, records, extraDays)` — runs a specific algorithm by ID
- `listAlgorithms()` — returns all registered algorithms
- `DEFAULT_ALGORITHM_ID` — the default algorithm ID (`regression-v1`)

The base `CircadianAnalysis` type contains only common fields (`globalTau`, `days`, etc.). Algorithm-specific data (e.g., `anchors`, `anchorCount` for the regression algorithm) is in `RegressionAnalysis` which extends the base type.

### Segment isolation at data gaps

When the dataset contains data gaps >14 days between consecutive records, `analyzeCircadian` splits the records into independent segments at each gap boundary using `splitIntoSegments`. Each segment is analyzed with the full pipeline (`analyzeSegment`) — anchor classification, unwrapping, outlier detection, sliding-window regression, and smoothing all operate only on the segment's own data. This prevents pre-gap data from influencing post-gap estimates (e.g., a 300-day tau=24.2 segment won't pull the local tau of a post-gap tau=25.0 segment).

After independent analysis, `mergeSegmentResults` concatenates the per-segment days arrays, inserts `isGap: true` placeholder days for the gap periods between segments, and computes the `globalTau` from overlay midpoints across all segments (unwrapping per-segment, then bridging across gaps to maintain a continuous phase sequence for the regression).

Segments with fewer than 2 anchor candidates are skipped (too few records for meaningful analysis). Forecast days (`extraDays`) are only appended to the last segment. Gaps shorter than 14 days are not split — those records stay in the same segment and are analyzed together.

### Forecast extrapolation

When forecast days are requested, the regression from the last data day (the "edge fit") is frozen and extrapolated forward. The forecast slope is regularized using a regional fit centered on the last data day (±60-day window) as fallback, rather than the global fit, to avoid regime-change bias (e.g., a long DSPD period pulling the forecast slope toward zero). Forecast confidence decays exponentially: `edgeBaseConfidence * exp(-0.1 * daysFromEdge)`, reaching ~50% at 7 days and ~5% at 30 days. The forecast overlay is drawn in amber (`rgba(251, 191, 36, alpha)`) to distinguish it from the purple historical overlay.

### Output

`CircadianAnalysis` contains:

- `globalTau` / `globalDailyDrift`: Derived from weighted linear regression on unwrapped overlay midpoints (matches the visible overlay drift rate)
- `anchors[]`: Array of `AnchorPoint` with `dayNumber`, `midpointHour`, `weight`, `date`
- `anchorCount`: Number of anchors used
- `medianResidualHours`: Median absolute deviation of anchor residuals from the model
- `days[]`: Per-day `CircadianDay` with `nightStartHour`, `nightEndHour`, `localTau`, `localDrift`, `confidenceScore`, `confidence` (tier: "high"/"medium"/"low"), `anchorSleep?`, `isForecast`, `isGap`
- Legacy compat fields: `tau`, `dailyDrift`, `rSquared`

#### State-space model

The hidden state is `[phase, drift]` where phase is the sleep midpoint in continuous hours and drift is the daily phase shift (tau - 24). The state transition assumes phase advances by drift each day, with drift following a random walk:

```
x(t+1) = F · x(t) + w(t)
F = [[1, 1], [0, 1]]
Q = diag(Q_PHASE, Q_DRIFT)
```

Each sleep record provides a noisy observation of phase modulo 24h. The 24h ambiguity is resolved by selecting the branch closest to the predicted phase — the prediction-correction cycle naturally handles phase wrapping without seed selection or expansion logic.

#### Adaptive measurement noise

Measurement noise R is inversely proportional to sleep quality, duration, and main-sleep status:

```
R(t) = R_BASE / (quality × durFactor × mainFactor)
```

This replaces the discrete 3-tier anchor classification with a continuous weighting scheme.

#### Outlier gating

Before each measurement update, the Mahalanobis distance is computed. Observations exceeding `GATE_THRESHOLD` standard deviations are rejected. Unlike a fixed threshold, this gate adapts to current uncertainty — it widens when the filter is uncertain and tightens when confident.

#### RTS backward smoother

After the forward Kalman pass, a Rauch-Tung-Striebel backward smoother runs a single backward pass to incorporate future information. This replaces the regression algorithm's 6-pass post-hoc smoothing with a mathematically optimal (MMSE) smoother.

#### Pipeline

1. **Observation extraction**: Convert SleepRecord[] to per-day observations with adaptive noise
2. **Forward Kalman filter + RTS smoother**: Initialize from first observations, run predict/update forward, then RTS backward
3. **Output generation**: Convert smoothed states to CircadianDay[] with confidence from posterior covariance

#### Confidence scoring

Confidence is derived directly from the posterior phase covariance: `1 / (1 + sqrt(P_phase))`. This is inherently calibrated — uncertainty grows naturally during data gaps and shrinks with observations. Forecast confidence additionally decays with `exp(-0.1 × daysFromEdge)`.

### Circular State-Space Filter Algorithm (`csf-v1`)

The CSF algorithm uses a Von Mises circular distribution for measurement updates while tracking phase in an unbounded space for drift estimation. This hybrid approach combines the robustness of circular probability for handling 24h wraps with the ability to track cumulative drift over long time periods.

#### State-space model

The state is `[phase, tau]` where phase is the circadian phase (unbounded hours from first observation) and tau is the circadian period. State evolution:

```
phase(t+1) = phase(t) + tau(t) - 24  (no modulo - tracks absolute phase)
tau(t+1) = tau(t) + noise
```

#### Von Mises measurement update

The CSF uses the Von Mises distribution (circular analog of the normal distribution) for measurement updates, computing the circular distance between predicted and observed phase:

```
C_post = kappa_prior * cos(phase_prior_normalized) + kappa_meas * cos(measurement)
S_post = kappa_prior * sin(phase_prior_normalized) + kappa_meas * sin(measurement)
phase_post_circular = atan2(S_post, C_post)
phase_post = phase_prior + circular_diff(phase_post_circular, phase_prior_normalized)
```

This handles 24-hour wraparound naturally while maintaining unbounded phase for drift tracking. Both the phase correction and the tau innovation are clamped to `±maxCorrectionPerStep` (4.0h) to prevent off-branch observations from yanking the overlay during bimodal sleep periods.

#### Pipeline

1. **Anchor preparation**: Continuous weight computation (same as regression algorithm)
2. **Forward filter + RTS smoother**: Initialize from first anchor, predict/update forward, then RTS backward pass
3. **Output smoothing**: Gaussian smoothing of phase and tau (σ=5 days, window=±8)
4. **Bidirectional edge correction + forecast re-anchoring**: Re-anchors first and last ~10 data-backed days using Gaussian-weighted local fit to nearby anchor clock hours (unwrapped clock-hour space, quadratic blend ramp). For the start edge, the correction addresses the forward filter's lack of prior observations; for the end edge, it corrects the RTS smoother's unsmoothed terminal state. Forecast days are then linearly extrapolated from the corrected last data day using the anchor-based slope, replacing the forward-pass predictions.
5. **Output generation**: Convert smoothed states to CircadianDay[] with normalized phase

#### Key advantages

- No phase unwrapping required (Von Mises handles circular observations)
- Phase tracked in unbounded space (accurate drift estimation over years)
- Unified confidence from posterior variance
- Natural handling of gaps through filter prediction

### CSF algorithm parameters

| Constant               | Value                                                                                 | Location           |
| ---------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| Process noise phase    | 0.08 h² (phase uncertainty growth per day)                                            | `csf/types.ts`     |
| Process noise tau      | 0.001 h²/day² (tau drift rate)                                                        | `csf/types.ts`     |
| Measurement kappa base | 0.35 (base Von Mises concentration)                                                   | `csf/types.ts`     |
| Tau prior              | 25.0 h (forward-biased for N24)                                                       | `csf/types.ts`     |
| Tau prior variance     | 0.1 h² (initial tau uncertainty)                                                      | `csf/types.ts`     |
| Tau clamp range        | [22.0, 27.0] h (physiological bounds)                                                 | `csf/types.ts`     |
| Anchor tiers           | Continuous weight (same as regression)                                                | `csf/anchors.ts`   |
| Ambiguity resolution   | Snaps measurements to predicted phase's branch                                        | `csf/filter.ts`    |
| Output smoothing       | Phase/tau: σ=5 days, window=±8; Duration: σ=3 days, window=±5                         | `csf/smoothing.ts` |
| Edge correction        | Bidirectional, window=10 days, anchor σ=7 days, radius=±15 days, quadratic blend ramp | `csf/smoothing.ts` |
| Weight scaling         | Linear (not squared) - reduces Tier A dominance                                       | `csf/filter.ts`    |
| Tau regularization     | Asymmetric: 4x stronger pull toward forward drift                                     | `csf/filter.ts`    |
| Max correction/step    | 4.0 h (clamps phase and tau innovation per update)                                    | `csf/types.ts`     |

### Phase consistency metric

The ground truth test includes a phase consistency metric that measures how well the algorithm's predicted phase changes match what local tau predicts. For each consecutive day pair:

```
expected_drift = localTau - 24  (hours/day)
actual_change = phase[next] - phase[current]  (circular difference)
inconsistency = |actual_change - expected_drift|
```

This penalizes algorithms that either:

- **Overfit** to individual sleep records (CSF was 0.85-2.01h p90 before tuning)
- **Over-smooth** and fail to track real N24 drift (Kalman was 0.03-0.04h p90 before tuning)

After tuning, both algorithms achieve phase consistency comparable to regression (0.49-0.90h p90).

## Sleep score regression weights

| Weight             | Value    | Location                   |
| ------------------ | -------- | -------------------------- |
| Intercept          | 66.607   | `calculateSleepScore.ts:5` |
| Duration score     | 9.071    | `calculateSleepScore.ts:6` |
| Deep + REM minutes | 0.111    | `calculateSleepScore.ts:7` |
| Wake percentage    | -102.527 | `calculateSleepScore.ts:8` |

## Phase coherence periodogram

`computePeriodogram()` in `models/periodogram.ts` computes a windowed phase coherence periodogram using the weighted Rayleigh test.

For each trial period P (default 23–26h in 0.01h steps), anchor times are folded modulo P and mapped to angles on the unit circle. The squared mean resultant length R² measures phase concentration:

- R² ≈ 1 → all anchors align at one phase → strong periodicity at P
- R² ≈ 0 → anchors spread uniformly → no periodicity at P

### Windowed approach

Because tau varies over time, computing global R² across years of data with variable tau produces a weak signal. Instead, R² is computed within overlapping sliding windows (~120 days, stepped by 30 days) where tau is approximately stable, then averaged across all windows. If the data span is short enough (≤ 1.5× window size), a single global window is used.

Minimum 8 anchors per window. Results are Gaussian-smoothed (sigma = 3 bins) to suppress aliasing sidelobes.

### Display trimming

The result includes both full-range points and a `trimmedPoints` array auto-focused on the region of interest: the extent of significant peaks (plus padding), always including 24h as a reference. If no peaks exceed the significance threshold, the display centers on the peak period ±1h.

### Significance threshold

The Rayleigh test significance threshold for p < 0.01: `R²_crit = -ln(0.01) / N_eff`, where N_eff is the effective sample size accounting for non-uniform weights.

## Manual overlay editor

The overlay editor provides a path-style tool for manually defining the circadian overlay, producing ground-truth data for regression testing.

### Overlay path model (`overlayPath.ts`)

Control points are `{ date: string, midpointHour: number }` where midpoints are stored unwrapped (can be <0 or >24) to avoid phase-wrap ambiguity. `interpolateOverlay()` produces per-day `OverlayDay` values via piecewise linear interpolation between control points, with flat extrapolation beyond endpoints. Width is applied uniformly from a global sleep window parameter.

Phase unwrapping on point insertion uses the nearest-branch heuristic (same as `circadian/unwrap.ts`): `while (newMid - refMid > 12) newMid -= 24`.

### Canvas interaction (`useOverlayEditor.ts`)

A distinct edit mode (calendar mode only, disabled in tau mode) switches the canvas from tooltip behavior to editor behavior:

- **Click** on plot area adds a control point at the clicked (date, hour)
- **Mousedown** on an existing handle starts a drag (10px hit radius)
- **Right-click** on a handle deletes it

Control point handles are drawn both on the path line in the plot area and in a gutter column to the left of date labels (extends `leftMargin` by 20px in edit mode), making them clickable even at small row heights.

### Rendering

When manual overlay control points exist, the interpolated overlay renders in cyan (`rgba(6, 182, 212, 0.3)`) replacing the algorithm overlay. In edit mode, the algorithm overlay is also drawn at very low alpha (0.05) as a dim reference. The editor layer (handles + path line) draws last, on top of everything.

### Ground-truth export

"Export with overlay" produces a JSON file containing both `sleep` (record array) and `overlay` (per-day `OverlayDay[]`) arrays. The overlay is the fully interpolated result — frozen and independent of how it was produced. This file can be split into `sleep.json` and `overlay.json` for use in the ground-truth test data repository.

### Ground-truth test data

The `test-data/` directory (gitignored, independent git repo) contains subdirectories with `sleep.json` + `overlay.json` pairs. `circadian.groundtruth.test.ts` iterates all pairs, runs `analyzeWithAlgorithm()` for each registered algorithm on each dataset, and scores the algorithm's output against the manual overlay using circular midpoint distance (mean, median, p90). Tests skip gracefully when `test-data/` is missing.

## PNG export

`exportActogramPNG()` in `utils/exportPNG.ts` composites a self-contained PNG image from the live canvases. It creates an offscreen canvas at the actogram's native DPR resolution, draws a header (title + stats: record count, tau, daily drift, R², day span), copies the actogram canvas via `drawImage`, optionally copies the periodogram canvas (when visible), and appends a color legend (stage colors or quality gradient depending on current color mode). The result is downloaded as `fitbit-actogram-YYYY-MM-DD.png` via an anchor-click pattern.

The canvases are accessed via `document.getElementById` (`id="actogram-canvas"` and `id="periodogram-canvas"`) to avoid threading refs through context. The "Save as PNG" button appears in `DataToolbar.tsx` alongside the existing export buttons.

## Tooltip interaction

The `getTooltipInfo` callback converts mouse coordinates to row index and hour, then searches for a matching sleep block. For v1.2 records with stage data, the tooltip shows a breakdown: `D:78 L:157 R:63 W:81min`. It also shows the quality score percentage. Hovering over the circadian overlay shows the estimated night window, local tau, and confidence level (and whether it's a forecast). The tooltip is rendered as a fixed-position React div overlaying the canvas.

## CLI analysis tool

`cli/analyze.ts` provides a Node.js entry point for running the analysis pipeline outside the browser. It uses `tsx` (TypeScript Execute, a dev dependency) to run TypeScript directly in Node.js without a compile step.

```
npx tsx cli/analyze.ts <sleep-data.json> [algorithmId]
# or: npm run analyze -- <sleep-data.json>
```

The CLI reads a JSON file with `fs.readFileSync`, parses it with `parseSleepData()` (the same pure function the browser app uses), and runs `analyzeWithAlgorithm()` to print summary statistics. An optional algorithm ID selects which algorithm to use (defaults to `regression-v1`). It serves as a debugging harness — copy and modify it to import additional model functions, log intermediate values, or test algorithm changes without launching the browser.

A separate `tsconfig.cli.json` provides Node.js-compatible settings (`module: "NodeNext"`, `moduleResolution: "NodeNext"`) for type-checking CLI code. The main `tsconfig.json` and `npm run build` remain unchanged (browser-only).

## Test coverage

| Test file                                 | Category    | Purpose                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `circadian.integration.test.ts`           | correctness | Core algorithm correctness: tau detection, gaps, segments, DSPD→N24 transitions (runs on all algorithms)                                                                                                                                   |
| `circadian.scoring.test.ts`               | mixed       | Benchmarks (tau sweep, phase accuracy, noise/gap/outlier degradation, forecast, cumulative shift) + correctness (confidence calibration, overlay smoothness, drift limits) (runs on all algorithms; periodogram benchmark regression-only) |
| `circadian.regimechange.test.ts`          | correctness | Bidirectional regime changes, ultra-short periods (τ < 24), backward bridge validation (runs on all algorithms)                                                                                                                            |
| `regression/regression.internals.test.ts` | correctness | Unit tests for regression internal helpers (classifyAnchor, regression, unwrapping)                                                                                                                                                        |
| `circadian.groundtruth.test.ts`           | correctness | Ground-truth overlay scoring (algorithm vs manually curated overlays, skips if no data, runs on all algorithms)                                                                                                                            |
| `overlayPath.test.ts`                     | correctness | Overlay interpolation: linear interp, phase wrapping, extrapolation                                                                                                                                                                        |
| `lombScargle.test.ts`                     | correctness | Periodogram computation tests                                                                                                                                                                                                              |

### Test visualization

Set `VIZ=1` to generate self-contained HTML actograms in `test-output/` during test runs. Each HTML file shows sleep blocks (blue), algorithm overlay (purple/amber), and ground truth midpoints (green dots) on a dark-background canvas. Hover for per-day tooltip with localTau, confidence, and phase error. Files are named `{test}_{scenario}_{algorithm}.html`.

### Test categories

Tests are split into two categories:

- **Correctness tests** (`correctness:` prefix) — hard-fail on violations. Cover overlay smoothness (max 3h jump), hard drift limits, confidence calibration, sanity bounds. These should never reject a legitimately better algorithm.
- **Benchmark tests** (`benchmark:` prefix) — log `BENCHMARK` lines with soft targets for machine parsing, but only hard-fail on catastrophic guards (very wide bounds, ~10-25x headroom). Enables automated algorithm optimization without false rejections.

Benchmark output format (tab-separated, greppable):

```
BENCHMARK	label	metric=value	target<threshold	PASS|REGRESSED
```

Ground truth compact output (default, set `VERBOSE=1` for full diagnostics):

```
GTRESULT	dataset-name	n=245	mean=1.23h	median=0.98h	p90=2.45h	bias=+0.34h	drift-agree=82%	tau-delta=+1.2min	streaks=2	max-streak=8d	penalty=0.15
```

### Hard drift limits

All tests enforce `localDrift` in [-1.5, +3.0] h/day via `assertHardDriftLimits()` from `fixtures/driftPenalty.ts`. This corresponds to `localTau` in [22.5, 27.0]. Values outside this range indicate a broken algorithm — no real circadian rhythm exceeds these bounds.

### Drift penalty scoring

`computeDriftPenalty()` scores prolonged periods near the hard limits:

- **Penalty zones**: drift in [-1.5, -0.5] or [2.0, 3.0] (within 1h of hard limits)
- **Per-day penalty**: linear interpolation (0 at zone inner edge, 1.0 at hard limit)
- **Consecutive multiplier**: day penalty × streak length for superlinear growth (3 consecutive days at penalty 0.5 each → 0.5×1 + 0.5×2 + 0.5×3 = 3.0)
- Reported as `DRIFT_PENALTY` lines in benchmark tests and `penalty=` field in ground truth compact output

## Tailwind CSS v4

Tailwind is imported via `@import "tailwindcss"` in `index.css` and processed by the `@tailwindcss/vite` plugin. No `tailwind.config.js` is needed in v4 — it auto-detects content sources. All component styling uses Tailwind utility classes directly in JSX, with custom properties in `index.css` for the body background and font.
