# fitbit-n24

https://n24.aozora.one/

![screenshot_2026_01_31](https://github.com/Aozora7/fitbit-n24/raw/master/images/screenshot_2026_01_31.png)

A client-side React application that visualizes Fitbit sleep data for people with non-24-hour sleep-wake disorder (N24). It renders sleep records as an actogram — a raster plot where each row is one calendar day — making the characteristic circadian drift pattern immediately visible. It estimates the user's circadian period using quality-weighted sliding-window regression and overlays the predicted circadian night with confidence-based transparency.

In many aspects inspired by [fitbit-sleep-vis](https://github.com/carrotflakes/fitbit-sleep-vis) but is implemented completely independently.

## Features

- **Actogram visualization**: Canvas-based raster plot with one row per calendar day, newest first
- **Sleep stage coloring**: Deep (dark blue), light (blue), REM (cyan), wake (red) from Fitbit's v1.2 stage data; falls back to asleep/restless/awake coloring for v1 classic data
- **Variable-rate circadian estimation**: Sliding-window weighted least squares regression that captures how tau changes over time, with quality-scored anchor selection and outlier rejection
- **Circadian night overlay**: Purple band with confidence-based opacity — more opaque where data is dense, transparent where sparse
- **OAuth PKCE authentication**: Sign in with Fitbit directly from the browser, no server needed
- **Progressive data loading**: Actogram renders and updates as each page of API data arrives (100 records per page)
- **Import/export**: Load data from JSON files or export fetched API data for offline use
- **Double-plot mode**: 48-hour row width for visualizing patterns that cross midnight
- **Interactive tooltips**: Hover over any sleep block to see date, times, duration, efficiency, and stage breakdown
- **Adjustable row height**: Slider to zoom between dense overview (2px) and detailed view (16px)

## Tech stack

| Layer         | Choice                 |
| ------------- | ---------------------- |
| Build         | Vite                   |
| UI            | React 19 + TypeScript  |
| CSS           | Tailwind CSS v4        |
| Visualization | HTML Canvas + d3-scale |
| Auth          | OAuth 2.0 PKCE         |

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:5173.

### Fitbit API setup

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
  main.tsx              Entry point, provider hierarchy
  App.tsx               Layout shell (no logic)
  AppContext.tsx         Global state, derived values, context provider
  index.css             Tailwind directives + global styles

  api/                  Fitbit API types, fetch wrapper, paginated sleep list
  auth/                 OAuth 2.0 PKCE flow, auth context provider
  data/                 Multi-format JSON parsing, data fetching hook
  models/               Actogram row transform, circadian estimation algorithm
  components/           UI components (header, toolbar, controls, actogram, legend, slider)
```

## Known issues and limitations

### Variable circadian period

The sliding-window approach captures gradual changes in tau but cannot detect sudden phase shifts (e.g., from jet lag or medication changes). Change-point detection would help here.

### Classic-type records

Some older Fitbit records use the "classic" format (asleep/restless/awake) even through the v1.2 API. These records don't have sleep stage data and receive a capped quality score, which means the algorithm treats them as lower-confidence anchors.

### Circadian overlay width

The overlay uses an 8-hour window centered on the predicted midpoint. Actual sleep durations vary, and the overlay can appear too wide or too narrow for individual days.
