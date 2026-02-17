# fitbit-n24

https://n24.aozora.one/

![screenshot](https://github.com/Aozora7/fitbit-n24/raw/master/images/screenshot.png)

A client-side React application that visualizes Fitbit sleep data in a way that's helpful for people with non-24-hour sleep-wake disorder (N24). The main feature is an actogram with sleep stage data, and an overlay that displays estimated circadian night on each day, calculated based on the entire visible data set.

In many aspects inspired by [fitbit-sleep-vis](https://github.com/carrotflakes/fitbit-sleep-vis) as I've been using it for years, but this project is written completely from scratch due to vastly different objectives and implementation besides fetching.

## Features

**Visualization**

- Canvas actogram with sleep stage coloring, one row per day
- Periodogram for circadian frequency analysis
- Optional double-plot mode for patterns crossing row boundaries
- Adjustable row height
- Adjustable row width to match the data's circadian period, allowing sleep records to line up
- Interactive tooltips with date, times, duration, efficiency, stage breakdown

**Circadian analysis**

- Estimated circadian night overlay (purple) computed from sleep data
- Forecast circadian night 2/7/30 days ahead using recent trend
- Schedule overlay (green) to compare circadian night against weekly commitments

**Data**

- Fetch from Fitbit API with progressive loading and IndexedDB caching
- Import/export JSON
- Date range filter for all visualizations and calculations
- Export what you see as PNG

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

- **Fetch from Fitbit**: Sign in via OAuth and fetch all historical sleep data (v1.2 API with sleep stages). Data is cached in IndexedDB; subsequent fetches only retrieve new records.
- **Import JSON**: Load a previously exported file or raw Fitbit API v1.2 response data
- **Export JSON**: Save the current dataset as a JSON file that can be re-imported later

Supported import formats:

- Fitbit API v1.2 response: `{ "sleep": [...] }` or array of pages
- Previously exported data from this app

## Project structure

```
src/
  main.tsx              Entry point, provider hierarchy
  App.tsx               Layout shell (no logic)
  AppContext.tsx        Global state, derived values, context provider
  index.css             Tailwind directives + global styles

  api/                  Fitbit API types, fetch wrapper, paginated sleep list
  auth/                 OAuth 2.0 PKCE flow, auth context provider
  data/                 Data loading, IndexedDB caching, fetch orchestration
  models/               Actogram row transform, circadian estimation, sleep scoring, periodogram
  components/           UI components (header, toolbar, controls, actogram, periodogram, legend, schedule editor)
```
