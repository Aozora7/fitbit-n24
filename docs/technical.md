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
            +---> analyzeCircadian()  (anchor selection, sliding-window robust regression)
            |       -> CircadianAnalysis { days: CircadianDay[], globalTau, ... }
            |       -> useActogramRenderer() (purple/amber overlay band with variable alpha)
            |
            +---> computeLombScargle()  (windowed phase coherence periodogram)
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
- `importFromFile(file)`: Create a blob URL from the file and delegate to `loadLocalData`

### `useFitbitData.ts`

Orchestrator hook that wraps `useSleepData` with fetch lifecycle, caching, and export:

- `startFetch(token, userId)`: Two-phase fetch — load IndexedDB cache first, then fetch only records newer than the latest cached date via `fetchNewSleepRecords()`. Falls back to full fetch via `fetchAllSleepRecords()` if no cache exists.
- `stopFetch()`: Aborts the current fetch via `AbortController`, keeping already-fetched data.
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

### Sleep block rendering

Three rendering paths based on color mode and data availability:

1. **Quality mode**: Solid color based on `sleepScore`, mapped through a red→yellow→green HSL gradient (hue 0°→120°, scaled from score range 0.5–1.0).

2. **Stage data** (block > 5px wide): `drawStageBlock()` renders each `SleepLevelEntry` as a colored rectangle. Stage entry times are mapped to x-axis coordinates by computing absolute time boundaries for the block and linearly mapping entry positions. Supports both calendar mode (reconstructs midnight from record start) and tau mode (uses `row.startMs`).

3. **Solid fallback**: A single light blue rectangle for blocks too narrow for stage detail or records without stage data.

### Stage colors
| Stage | Color | Hex |
|---|---|---|
| Deep | Dark blue | `#1e40af` |
| Light | Blue | `#60a5fa` |
| REM | Cyan | `#06b6d4` |
| Wake | Red | `#ef4444` |

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

`analyzeCircadian()` in `models/circadian.ts` estimates the free-running circadian period using a multi-stage pipeline.

### Step 1: Quality scoring

Each sleep record receives a quality score (0-1) via `calculateSleepScore()` in `models/calculateSleepScore.ts`. This uses a regression model with weights fitted to a dataset of Fitbit records with known quality scores:

```
score = 66.607 + 9.071 * durationScore + 0.111 * deepPlusRemMinutes - 102.527 * wakePct
```

Where:
- **durationScore** (0-1): Piecewise function of `minutesAsleep/60` — ramps 0→0.5 for 0-4h, 0.5→1.0 for 4-7h, plateau at 7-9h, declines to 0 for 9-12h
- **deepPlusRemMinutes**: `deep + rem` minutes from stage summary. For classic records without stage data, estimated as 39% of `minutesAsleep`
- **wakePct**: `wake minutes / timeInBed` (or `minutesAwake / timeInBed` for classic records)

The raw score is clamped to 0-100, rounded, then divided by 100 to produce a 0-1 value stored as `sleepScore` on each `SleepRecord`.

### Step 2: Tiered anchor classification

Records are classified into three tiers based on duration and quality score:

| Tier | Duration | Quality | Base Weight | Purpose |
|---|---|---|---|---|
| A | >= 7h | >= 0.75 | 1.0 | High-confidence circadian sleep |
| B | >= 5h | >= 0.60 | 0.4 | Moderate-confidence |
| C | >= 4h | >= 0.40 | 0.1 | Gap-fill only |

The effective weight for each anchor is `baseWeight * quality * durFactor`, where `durFactor = min(1, (durationHours - 4) / 5)`. This means longer, higher-quality sleeps receive more influence in the regression. Naps (`isMainSleep = false`) receive an additional 0.15× weight multiplier — they still contribute data but cannot dominate regression or unwrapping. This prevents false phase jumps when a main sleep and a nap on the same day both qualify as anchors.

Tier C anchors are only included when the maximum gap between consecutive A+B anchor dates exceeds 14 days, indicating sparse coverage that needs filling.

When multiple qualifying records exist for the same `dateOfSleep`, only the one with the highest weight is kept.

### Step 3: Midpoint calculation and seed-based phase unwrapping

For each anchor, the sleep midpoint is computed as fractional hours from the first record's midnight (absolute time), paired with a day index for regression.

The midpoint sequence is unwrapped using a seed-based algorithm to handle 24-hour wraparound. Sequential pairwise unwrapping from the first anchor is vulnerable to cascading errors when early data is noisy (e.g. scattered naps, polyphasic sleep, manual logs) — a noisy start can be misinterpreted as 24h wraps, producing a catastrophically wrong trajectory. The seed-based approach avoids this by finding a high-confidence region first.

1. **Seed region selection** (`findSeedRegion`): A 42-day window is slid across the timeline (~30 evaluation points). At each position, anchors are gathered, locally pairwise-unwrapped on a copy, and fit with weighted linear regression. Each window is scored on a weighted combination of: residual MAD (35%), anchor density (25%), average anchor weight (25%), and slope plausibility (15%). Slope plausibility penalizes extreme slopes outside the -0.5 to +3.0 h/day range. The highest-scoring window becomes the seed. For short datasets (<42 days), the entire anchor array is used as the seed.

2. **Seed unwrapping** (Phase A): The seed region is pairwise-unwrapped. This is safe because the seed was selected for internal consistency.

3. **Forward expansion** (Phase B): Starting from the seed's end, each subsequent anchor is snapped to within 12h of a prediction derived from already-unwrapped neighbors within 30 days. Neighbors are Gaussian distance-weighted (σ=14 days). With 2+ neighbors, a weighted linear regression predicts the midpoint. With 1 neighbor, a simple 12h snap is used. With 0 neighbors (very sparse data), the anchor is left as-is. **Branch conflict resolution**: Both regression-based and nearest-neighbor (pairwise) branch predictions are computed. When they agree, the regression is used. When they disagree and the anchor is clearly close to its nearest neighbor (<6h, ≤7 days away), the pairwise prediction is preferred — this prevents regression overextrapolation from steep pre-fragmentation data placing anchors on the wrong 24h branch.

4. **Backward expansion** (Phase C): Same as forward expansion but proceeding from the seed's start toward the beginning of the data. This allows noisy early data to be constrained by the clean seed region rather than propagating errors forward.

### Step 4: Outlier rejection

A preliminary global fit is computed across all anchors. Records with residuals exceeding **8 hours** are flagged as outliers. These are removed only if they constitute less than 15% of total anchors, then the remaining anchors are re-unwrapped using the same seed-based algorithm.

### Step 5: Sliding-window robust regression

For each calendar day, a sliding window is evaluated:

1. Collect all anchors within **±21 days** (42-day window)
2. Apply Gaussian weights (sigma = **14 days**) multiplied by each anchor's tier weight
3. Fit **robust weighted regression** using IRLS (iteratively reweighted least squares) with Tukey bisquare M-estimation (tuning constant = 4.685, up to 5 iterations). This downweights outliers that survived Step 4.
4. Extract local tau = `24 + slope`, along with quality metrics (anchor count, mean quality, residual MAD, average A-tier sleep duration)
5. **Slope regularization**: The local slope is blended toward a **regional** fit slope (±60-day window) based on window strength. `slopeConf = min(1, pointsUsed/expected) × (1 - min(1, residualMAD/4))`. When the local and regional slopes differ by >0.3 h/day AND the local fit has good quality (residual MAD < 2.0h), `slopeConf` is boosted to prevent blending across regime boundaries (e.g., entrained↔N24 transitions). The MAD gate prevents fragmented sleep from triggering false regime changes. The reported `localTau` uses `regularizedSlope = slopeConf × localSlope + (1 - slopeConf) × regionalSlope`, clamped to >= 0 (the circadian clock doesn't run backward). Using a regional rather than global fallback prevents distant historical data (with potentially different tau) from pulling local estimates. The 120-day regional window (reduced from 180 days) improves responsiveness to regime changes such as DSPD-to-N24 transitions. If the regional slope is implausible (outside -0.5 to +2.0 h/day, e.g. due to unwrapping gaps), the global fit slope is used instead. The predicted midpoint uses centroid-anchored extrapolation: the regression's prediction at the weighted mean x of its anchors, then extrapolated to the target day at the regularized slope. For symmetric windows this closely matches the raw regression; for asymmetric windows (fragmented periods) this constrains the overlay to advance at the regularized rate.
6. Compute a composite confidence score: `0.4 * density + 0.3 * quality + 0.3 * (1 - residualSpread)`

If fewer than **6 anchors** fall in the window, it expands progressively: first to ±32 days, then to ±60 days (120-day window).

### Step 6: Per-day projection

For each calendar day, the local regression predicts a midpoint. A window centered on this midpoint defines the estimated circadian night. The window duration is based on the average sleep duration of A-tier anchors in the local window, falling back to 8 hours if no A-tier data is available.

The circadian overlay uses the day's confidence score to modulate alpha: `0.1 + confidenceScore * 0.25`.

### Step 7: Jump-targeted overlay smoothing

After all per-day predictions are computed, a two-pass post-hoc smoothing corrects artifacts from the sliding window approach.

**Pass 1 — Anchor-based smoothing** (for low-confidence regions):
1. Flag days where `slopeConf < 0.4` (fragmented/uncertain windows), plus ±5 day margins for smooth transitions.
2. For flagged days with sufficient nearby anchors (cumulative weight > 0.5), compute a smoothed midpoint from actual anchor sleep positions: residuals from global trend, Gaussian-weighted by distance (sigma=3) and anchor weight over ±7 days.
3. Blend the anchor-smoothed result with the raw prediction using distance-to-core fading: core days get full anchor weight, margin days fade linearly to zero.
4. This pulls the overlay toward where sleep actually occurs during fragmented periods, capturing local slope changes that the global trend misses.

**Pass 2 — Iterative jump smoothing** (for remaining discontinuities):
1. **Pairwise unwrap** modified predictions to remove 24h steps.
2. **Jump detection**: Flag days with circular jump > **2h** to neighbors, plus ±5 day margins.
3. **Prediction-based residual smoothing**: Gaussian-weighted average of neighboring predictions' residuals from global trend (`sigma=3`, ±7 days).
4. Iterate up to 3 times until no jumps exceed the threshold.

**Pass 3 — Forward-bridge backward-moving segments** (for sleep disruptions):
1. Compute normalized overlay midpoints and circular day-to-day deltas.
2. For each day, compute the expected drift from the average of neighboring `localDrift` values, clamped to >= 0 (the circadian clock doesn't run backward). Flag days where the daily shift deviates **0.5h+** backward from this expected drift. Only consider days with sufficient confidence (`MIN_CONFIDENCE = 0.3`).
3. Find contiguous runs of **3+ backward days**.
4. For qualifying runs, replace overlay with **forward** circular interpolation between the entry point (last non-backward day before the run) and exit point (first non-backward day after). Interpolation always goes in the positive (forward) direction. Sanity check: skip if the interpolation rate exceeds 3h/day.
5. This ensures the overlay always advances in the circadian drift direction through disrupted sleep periods, where off-rhythm anchors would otherwise pull the regression backward.

### Segment isolation at data gaps

When the dataset contains data gaps >14 days between consecutive records, `analyzeCircadian` splits the records into independent segments at each gap boundary using `splitIntoSegments`. Each segment is analyzed with the full pipeline (`analyzeSegment`) — anchor classification, unwrapping, outlier detection, sliding-window regression, and smoothing all operate only on the segment's own data. This prevents pre-gap data from influencing post-gap estimates (e.g., a 300-day tau=24.2 segment won't pull the local tau of a post-gap tau=25.0 segment).

After independent analysis, `mergeSegmentResults` concatenates the per-segment days arrays, inserts `isGap: true` placeholder days for the gap periods between segments, and computes the `globalTau` from overlay midpoints across all segments (unwrapping per-segment, then bridging across gaps to maintain a continuous phase sequence for the regression).

Segments with fewer than 2 anchor candidates are skipped (too few records for meaningful analysis). Forecast days (`extraDays`) are only appended to the last segment. Gaps shorter than 14 days are not split — those records stay in the same segment and are analyzed together.

### Forecast extrapolation

When forecast days are requested, the regression from the last data day (the "edge fit") is frozen and extrapolated forward. The forecast slope is regularized using a regional fit centered on the last data day (±60-day window) as fallback, rather than the global fit, to avoid regime-change bias (e.g., a long DSPD period pulling the forecast slope toward zero). Forecast confidence decays exponentially: `edgeBaseConfidence * exp(-0.1 * daysFromEdge)`, reaching ~50% at 7 days and ~5% at 30 days. The forecast overlay is drawn in amber (`rgba(251, 191, 36, alpha)`) to distinguish it from the purple historical overlay.

### Output

`CircadianAnalysis` contains:
- `globalTau` / `globalDailyDrift`: Derived from weighted linear regression on unwrapped overlay midpoints (matches the visible overlay drift rate)
- `anchors[]`: Array of `AnchorPoint` with `dayNumber`, `midpointHour`, `weight`, `tier`, `date`
- `anchorCount` / `anchorTierCounts`: How many anchors in each tier
- `medianResidualHours`: Median absolute deviation of anchor residuals from the model
- `days[]`: Per-day `CircadianDay` with `nightStartHour`, `nightEndHour`, `localTau`, `localDrift`, `confidenceScore`, `confidence` (tier: "high"/"medium"/"low"), `anchorSleep?`, `isForecast`, `isGap`
- Legacy compat fields: `tau`, `dailyDrift`, `rSquared`

## Phase coherence periodogram

`computeLombScargle()` in `models/lombScargle.ts` computes a windowed phase coherence periodogram using the weighted Rayleigh test. Despite the filename (a historical artifact), this is not a Lomb-Scargle spectral method.

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

## Tooltip interaction

The `getTooltipInfo` callback converts mouse coordinates to row index and hour, then searches for a matching sleep block. For v1.2 records with stage data, the tooltip shows a breakdown: `D:78 L:157 R:63 W:81min`. It also shows the quality score percentage. Hovering over the circadian overlay shows the estimated night window, local tau, and confidence level (and whether it's a forecast). The tooltip is rendered as a fixed-position React div overlaying the canvas.

## CLI analysis tool

`cli/analyze.ts` provides a Node.js entry point for running the analysis pipeline outside the browser. It uses `tsx` (TypeScript Execute, a dev dependency) to run TypeScript directly in Node.js without a compile step.

```
npx tsx cli/analyze.ts <sleep-data.json>
# or: npm run analyze -- <sleep-data.json>
```

The CLI reads a JSON file with `fs.readFileSync`, parses it with `parseSleepData()` (the same pure function the browser app uses), and runs `analyzeCircadian()` to print summary statistics. It serves as a debugging harness — copy and modify it to import additional model functions, log intermediate values, or test algorithm changes without launching the browser.

A separate `tsconfig.cli.json` provides Node.js-compatible settings (`module: "NodeNext"`, `moduleResolution: "NodeNext"`) for type-checking CLI code. The main `tsconfig.json` and `npm run build` remain unchanged (browser-only).

## Tailwind CSS v4

Tailwind is imported via `@import "tailwindcss"` in `index.css` and processed by the `@tailwindcss/vite` plugin. No `tailwind.config.js` is needed in v4 — it auto-detects content sources. All component styling uses Tailwind utility classes directly in JSX, with custom properties in `index.css` for the body background and font.
