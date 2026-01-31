# Technical implementation

## Architecture

The app follows a unidirectional data flow with two data paths — fetching from the Fitbit API and importing from local JSON files:

```
Fitbit API (v1.2)                   Local JSON file
  -> sleepApi.ts                      -> loadLocalData.ts
     (paginated fetch,                   (auto-detect v1/v1.2/exported format,
      progressive callback)               parse, sort, deduplicate)
  -> parseApiRecords()                      |
     (RawSleepRecordV12 -> SleepRecord)     |
  -> appendRecords() per page               |
            |                               |
            v                               v
        SleepRecord[] (useSleepData hook state)
            |
            +---> buildActogramRows()  (one row per calendar day, blocks clipped to [0, 24h])
            |       -> ActogramRow[]
            |       -> useActogramRenderer() (Canvas drawing)
            |
            +---> analyzeCircadian()  (quality scoring, anchor selection, sliding-window WLS)
                    -> CircadianAnalysis { days: CircadianDay[], globalTau, confidence, ... }
                    -> useActogramRenderer() (purple overlay band with variable alpha)
```

All computation happens in `useMemo` hooks inside React components. The actogram rows and circadian analysis are recomputed when the underlying records change. During a fetch, records accumulate incrementally and the visualization updates after each API page.

## Data formats

### Fitbit API v1 (classic)

Older records have per-minute data with three states:

- `minuteData[].value`: `"1"` = asleep, `"2"` = restless, `"3"` = awake
- `duration`: milliseconds
- No `isMainSleep` field; the app assumes true

### Fitbit API v1.2 (stages)

Modern records include sleep stage data:

- `levels.data[]`: array of `{ dateTime, level, seconds }` where level is `"deep"`, `"light"`, `"rem"`, or `"wake"`
- `levels.summary`: `{ deep: { minutes, count }, light: {...}, rem: {...}, wake: {...} }`
- `type`: `"stages"` (has full stage data) or `"classic"` (old format wrapped in v1.2 structure — has `levels.data` with `asleep`/`restless`/`awake` levels but no stage summary)
- `isMainSleep`: boolean distinguishing primary sleep from naps

The classic-type records in v1.2 have `levels.summary` with `asleep`/`restless`/`awake` keys instead of `deep`/`light`/`rem`/`wake`. The parser checks for the presence of stage keys before accessing them to handle both shapes safely.

### Unified SleepRecord

Both formats are parsed into a common `SleepRecord` type:

- `startTime` / `endTime`: `Date` objects
- `durationMs` / `durationHours`: computed from `duration`
- `efficiency`: 0-100
- `isMainSleep`: boolean
- `stages?`: `{ deep, light, rem, wake }` in minutes (only for v1.2 stages type)
- `stageData?`: `SleepLevelEntry[]` for per-interval rendering (v1.2)
- `minuteData?`: per-minute array (v1)

### Export format

The app exports raw API records wrapped in `{ "sleep": [...] }` when data was fetched from the API. This round-trips cleanly with import since it's the standard v1.2 API response shape. When exporting data that was imported (no raw API records available), the internal `SleepRecord` format is used, distinguished on re-import by the presence of `durationMs` instead of `duration`.

## Data loading

### `loadLocalData.ts`

Auto-detects and parses multiple JSON structures:

1. **Single API page**: `{ "sleep": [...] }`
2. **Array of API pages**: `[ { "sleep": [...] }, ... ]`
3. **Flat array of records**: `[ { "dateOfSleep": "...", ... }, ... ]`

For each record, format detection:
- `"durationMs"` present → internal exported format (re-hydrate Date objects)
- `"levels"` or `"type"` present → v1.2 API format
- Otherwise → v1 API format

Records are sorted by `startTime` ascending and deduplicated by `logId`.

### `useSleepData.ts`

React hook managing the records state with three mutation paths:

- `setRecords(recs)`: Replace all records (sort + dedup)
- `appendRecords(newRecs)`: Merge new records into existing set (for progressive loading)
- `importFromFile(file)`: Create a blob URL from the file and delegate to `loadLocalData`

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

`fetchAllSleepRecords()` paginates through the v1.2 sleep list endpoint:

- Starts from tomorrow's date (to capture today's sleep)
- Fetches 100 records per page, following `pagination.next` cursors
- Calls `onPageData(pageRecords, totalSoFar, page)` after each page, enabling progressive rendering
- Returns all raw records when complete

## Actogram data transform

`buildActogramRows()` in `models/actogramData.ts`:

1. Finds the date range from the earliest `startTime` to the latest `endTime`
2. Creates one `ActogramRow` per calendar day using **local** date formatting (`toLocalDateStr`) to avoid UTC/local timezone mismatches
3. For each sleep record, iterates calendar days it overlaps (using `localMidnight` for correct day boundaries)
4. Clips the record's time range to each day's `[0, 24)` hour window
5. Stores the clipped block with `startHour`/`endHour` (fractional hours from local midnight) and a reference to the original `SleepRecord`
6. Reverses the array so newest days come first

A sleep record from 23:00 to 07:00 produces two blocks: one on day 1 covering `[23, 24)` and one on day 2 covering `[0, 7)`.

**Timezone handling**: All day boundaries use local time via `Date.setHours(0,0,0,0)` and manual `getFullYear()/getMonth()/getDate()` formatting. Earlier versions used `toISOString().slice(0,10)` which caused UTC conversion bugs for non-UTC timezones.

## Canvas rendering

`useActogramRenderer.ts` draws everything in a single `useEffect` that runs when rows, circadian data, or config changes.

### Coordinate system
- Y axis: each row is `rowHeight` CSS pixels tall, starting at `topMargin`
- X axis: `d3-scale`'s `scaleLinear` maps `[0, 24]` (or `[0, 48]` in double-plot mode) to `[leftMargin, canvasWidth - rightMargin]`
- The canvas is sized at `devicePixelRatio` scale for sharp rendering, then drawn in CSS pixel coordinates after a `ctx.scale(dpr, dpr)` call

### Drawing order
1. Background fill
2. Hour grid lines (every 6 hours)
3. Hour labels at top
4. Circadian overlay (purple semi-transparent bands, alpha varies by confidence)
5. Sleep blocks (stage coloring, minute coloring, or solid fallback)
6. Date labels on left margin (every row at large heights, every 7th row at small heights)

### Sleep block rendering

Three rendering paths based on data availability and pixel width:

1. **v1.2 stage data** (block > 5px wide): `drawStageBlock()` renders each `SleepLevelEntry` as a colored rectangle. Stage entry times are mapped to x-axis coordinates by computing absolute time boundaries for the block (deriving the row's local midnight from the record's start time) and then linearly mapping entry positions within those boundaries.

2. **v1 minute data** (block > 10px wide): `drawMinuteBlock()` renders individual minute rectangles. The offset into `minuteData` is calculated from the block's clipped start relative to the record's start time.

3. **Solid fallback**: A single rectangle using light blue (v1.2) or blue (v1).

### Stage colors
| Stage | Color | Hex |
|---|---|---|
| Deep | Dark blue | `#1e40af` |
| Light | Blue | `#60a5fa` |
| REM | Cyan | `#06b6d4` |
| Wake | Red | `#ef4444` |

### v1 minute colors
| State | Color | Hex |
|---|---|---|
| Asleep | Blue | `#3b82f6` |
| Restless | Yellow | `#eab308` |
| Awake | Red | `#ef4444` |

### Double-plot mode
Each day's sleep blocks are drawn twice: at their normal position and shifted 24 hours right. The circadian overlay is also doubled. This preserves visual continuity for sleep that crosses midnight.

## Circadian period estimation

`analyzeCircadian()` in `models/circadian.ts` estimates the free-running circadian period using a multi-stage pipeline.

### Step 1: Quality scoring

Each sleep record receives a quality score (0-1):

- **v1.2 records with stage data**: `0.5 * remFraction + 0.25 * deepMinutes/90 + 0.25 * (1 - wakeFraction)` where `remFraction = rem / (rem + light + deep)` (excluding wake from total). REM percentage is the strongest signal — circadian-aligned sleep typically has ~21% REM vs ~9% for poorly-timed sleep.

- **v1 or classic records**: `min(efficiency / 100, 0.7)`. Capped at 0.7 because efficiency only measures restlessness, not sleep stage quality.

### Step 2: Tiered anchor classification

Records are classified into three tiers based on duration and quality:

| Tier | Duration | Quality | Weight | Purpose |
|---|---|---|---|---|
| A | >= 7h | >= 0.5 | 1.0 | High-confidence circadian sleep |
| B | >= 5h | >= 0.3 | 0.4 | Moderate-confidence |
| C | >= 4h | >= 0.2 | 0.1 | Gap-fill only (used if < 25% of days covered by A+B) |

When multiple qualifying records exist for the same `dateOfSleep`, only the one with the highest quality score is kept.

### Step 3: Midpoint calculation and phase unwrapping

For each anchor, the sleep midpoint is computed as fractional hours from the Unix epoch (absolute time), then converted to a day index for regression. The midpoint sequence is unwrapped: if consecutive midpoints jump by more than 12 hours, 24 hours is added or subtracted to maintain continuity.

### Step 4: Outlier rejection

A preliminary global linear regression is fit to all anchors. Records with residuals exceeding 4 hours are removed. This eliminates forced-schedule sleeps that passed the duration/quality thresholds but don't reflect the true circadian phase.

### Step 5: Sliding-window weighted least squares

For each calendar day, a 90-day Gaussian-weighted window is evaluated:

1. Collect all anchors within the window
2. Apply Gaussian weights (sigma = 30 days) multiplied by each anchor's tier weight
3. Fit weighted linear regression: `midpoint = slope * dayIndex + intercept`
4. Extract local tau = `24 + slope`, along with quality metrics (anchor density, mean quality, residual MAD)
5. Compute a composite confidence score: `0.4 * density + 0.3 * quality + 0.3 * (1 - residualSpread)`

Windows with fewer than 5 anchors or all anchors on the same day fall back to the global regression.

### Step 6: Per-day projection

For each calendar day, the local regression predicts a midpoint. An 8-hour window centered on this midpoint defines the estimated circadian night. The circadian overlay uses the day's confidence score to modulate alpha: `0.1 + confidence * 0.25`.

### Output

`CircadianAnalysis` contains:
- `globalTau` / `globalDailyDrift`: Confidence-weighted average of all local tau estimates
- `confidenceScore`: Overall dataset confidence
- `anchorCount` / `anchorTierCounts`: How many anchors in each tier
- `medianResidualHours`: Median absolute deviation of anchor residuals from the model
- `days[]`: Per-day `CircadianDay` with `nightStartHour`, `nightEndHour`, `localTau`, `confidenceScore`
- Legacy compat fields: `tau`, `dailyDrift`, `rSquared` for backward compatibility

## Tooltip interaction

The `getTooltipInfo` callback converts mouse coordinates to row index and hour, then searches for a matching sleep block. For v1.2 records with stage data, the tooltip shows a breakdown: `D:78 L:157 R:63 W:81min`. The tooltip is rendered as a fixed-position React div overlaying the canvas.

## Tailwind CSS v4

Tailwind is imported via `@import "tailwindcss"` in `index.css` and processed by the `@tailwindcss/vite` plugin. No `tailwind.config.js` is needed in v4 — it auto-detects content sources. All component styling uses Tailwind utility classes directly in JSX, with custom properties in `index.css` for the body background and font.
