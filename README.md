# fitbit-n24

https://n24.aozora.one/

![screenshot](https://github.com/Aozora7/fitbit-n24/raw/master/images/screenshot.png)

A client-side React application that visualizes Fitbit sleep data in a way that's helpful for people with non-24-hour sleep-wake disorder (N24). The main feature is an actogram with sleep stage data, and an overlay that displays estimated circadian night on each day, calculated based on the entire visible data set.

In many aspects inspired by [fitbit-sleep-vis](https://github.com/carrotflakes/fitbit-sleep-vis) as I've been using it for years, but this project is written completely from scratch due to vastly different objectives and implementation besides fetching.

## Features

- **Actogram visualization**: Canvas-based raster plot with one row per calendar day with sleep segment colors based on sleep stages
- **Periodogram visualization**: Provides frequency analysis of circadian rhythm in the data
- **Circadian night overlay**: Estimates circadian night based on sleep data and displays it as purple overlay on the actogram.
- **Circadian night forecast**: Predict circadian night for 2, 7, or 30 days ahead of the latest sleep record using the most recent circadian trend
- **Schedule overlay**: Define recurring weekly schedules (e.g., work hours) that display as green overlay on the actogram. You can use it to see when your predicted circadian night conflicts with your schedule.
- **Progressive data loading**: Actogram renders and updates as each page of API data arrives (100 records per page, which is the maximum Fitbit API allows)
- **Import/export**: Load data from JSON files or export fetched API data for offline use
- **Adjustable row width**: Set the actogram row length to the estimated circadian period (or any value between 23-26h) so that sleep records line up vertically
- **Double-plot mode**: Double row width for visualizing patterns that cross row boundaries
- **Interactive tooltips**: Hover over any sleep block to see date, times, duration, efficiency, and stage breakdown
- **Adjustable row height**: Slider provides vertical zoom for the actogram
- **Date filter**: Any continous subset of raw data can be selected, and all visualizations and calculations will only process that subset

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
  data/                 Multi-format JSON parsing, data fetching hook
  models/               Actogram row transform, circadian estimation algorithm
  components/           UI components (header, toolbar, controls, actogram, legend, slider)
```
