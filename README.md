# fitbit-n24

A client-side React application that visualizes Fitbit sleep data for people with non-24-hour sleep-wake disorder (N24). It renders sleep records as an actogram — a raster plot where each row is one calendar day — making the characteristic circadian drift pattern immediately visible. It estimates the user's circadian period using quality-weighted sliding-window regression and overlays the predicted circadian night with confidence-based transparency.

## Features

- **Actogram visualization**: Canvas-based raster plot with one row per calendar day, newest first
- **Sleep stage coloring**: Deep (dark blue), light (blue), REM (cyan), wake (red) from Fitbit's v1.2 stage data; falls back to asleep/restless/awake coloring for v1 classic data
- **Variable-rate circadian estimation**: Sliding-window weighted least squares regression that captures how tau changes over time, with quality-scored anchor selection and outlier rejection
- **Circadian night overlay**: Purple band with confidence-based opacity — more opaque where data is dense, transparent where sparse
- **OAuth PKCE authentication**: Sign in with Fitbit directly from the browser, no server needed
- **Progressive data loading**: Actogram renders and updates as each page of API data arrives (~100 records per page)
- **Import/export**: Load data from JSON files or export fetched API data for offline use
- **Double-plot mode**: 48-hour row width for visualizing patterns that cross midnight
- **Interactive tooltips**: Hover over any sleep block to see date, times, duration, efficiency, and stage breakdown
- **Adjustable row height**: Slider to zoom between dense overview (2px) and detailed view (16px)

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Build | Vite | Fast, zero-config for React + TypeScript |
| UI | React 19 + TypeScript | Type safety is critical for date/time math |
| CSS | Tailwind CSS v4 | Utility-first, minimal custom CSS needed |
| Visualization | HTML Canvas + d3-scale | Custom actogram rendering; d3-scale for axis math |
| Auth | OAuth 2.0 PKCE | Secure client-only auth without a backend |
| State | React Context + hooks | App is small enough to not need Redux/Zustand |

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173.

### Fitbit API setup (optional)

To fetch data directly from the Fitbit API:

1. Register an app at https://dev.fitbit.com/apps/new
   - OAuth 2.0 Application Type: **Client**
   - Callback URL: `http://localhost:5173`
2. Copy `.env.example` to `.env` and fill in your client ID:
   ```
   VITE_FITBIT_CLIENT_ID=your_client_id_here
   ```
3. Start the dev server and click "Sign in with Fitbit"

### Data sources

The app starts empty. You can:

- **Fetch from Fitbit**: Sign in via OAuth and fetch all historical sleep data (v1.2 API with sleep stages)
- **Import JSON**: Load a previously exported file, or raw Fitbit API response data (v1 or v1.2 format)
- **Export JSON**: Save the current dataset as a JSON file that can be re-imported later

Supported import formats:
- Fitbit API v1.2 response: `{ "sleep": [...] }` or array of pages
- Fitbit API v1 response: array of pages with `minuteData`
- Previously exported data from this app

## Project structure

```
src/
  main.tsx                    Entry point (wraps App in AuthProvider)
  App.tsx                     Root component: toolbar, controls, actogram, legend
  index.css                   Tailwind directives + global styles

  api/
    types.ts                  Fitbit API v1 + v1.2 types, unified SleepRecord type
    fitbit.ts                 Typed fetch wrapper with Bearer token auth
    sleepApi.ts               Paginated v1.2 sleep list fetching with progressive callback

  auth/
    oauth.ts                  PKCE helpers: verifier generation, challenge, token exchange
    AuthProvider.tsx           React context provider for auth state
    useAuth.ts                Consumer hook for auth context

  data/
    loadLocalData.ts          Multi-format JSON parser (v1, v1.2, exported internal format)
    useSleepData.ts           React hook: records state, import, append, set

  models/
    actogramData.ts           Transforms SleepRecord[] into ActogramRow[] (one row per day)
    circadian.ts              Quality scoring, tiered anchors, sliding-window WLS, confidence

  components/
    Actogram/
      Actogram.tsx            React component: canvas + tooltip overlay
      useActogramRenderer.ts  Canvas drawing: grid, stages, circadian overlay, tooltips
```

## Known issues and limitations

### Variable circadian period
The sliding-window approach captures gradual changes in tau but cannot detect sudden phase shifts (e.g., from jet lag or medication changes). Change-point detection would help here.

### Classic-type records
Some older Fitbit records use the "classic" format (asleep/restless/awake) even through the v1.2 API. These records don't have sleep stage data and receive a capped quality score, which means the algorithm treats them as lower-confidence anchors.

### Circadian overlay width
The overlay uses an 8-hour window centered on the predicted midpoint. Actual sleep durations vary, and the overlay can appear too wide or too narrow for individual days.

## Planned features

- Date range filtering and zoom
- Chi-squared periodogram as an alternative period estimation method
- Sleep quality trends and statistics panel
- Change-point detection for entrainment episodes
