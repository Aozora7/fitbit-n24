import { useState, useMemo, useCallback, useRef } from "react";
import { useSleepData, parseApiRecords } from "./data/useSleepData";
import { useAuth } from "./auth/useAuth";
import { analyzeCircadian } from "./models/circadian";
import { fetchAllSleepRecords } from "./api/sleepApi";
import type { RawSleepRecordV12 } from "./api/types";
import Actogram from "./components/Actogram/Actogram";
import type { ColorMode } from "./components/Actogram/useActogramRenderer";

/** Max canvas height in pixels (conservative cross-browser limit) */
const MAX_CANVAS_HEIGHT = 32_768;
/** Fixed margins in the actogram renderer (top + bottom) */
const ACTOGRAM_MARGINS = 50;

export default function App() {
  const { records, loading, error, setRecords, appendRecords, importFromFile } =
    useSleepData();
  const { token, loading: authLoading, error: authError, signIn, signOut } =
    useAuth();

  const [doublePlot, setDoublePlot] = useState(false);
  const [rowHeight, setRowHeight] = useState(5);
  const [showCircadian, setShowCircadian] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState("");
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("stages");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Keep raw API records for export
  const rawRecordsRef = useRef<RawSleepRecordV12[]>([]);
  // AbortController for cancelling fetch
  const fetchAbortRef = useRef<AbortController | null>(null);

  // If data ends today or yesterday, forecast one extra day so the user can see
  // their next optimal sleep time via the circadian overlay.
  const forecastDays = useMemo(() => {
    if (records.length === 0) return 0;
    const lastEnd = records[records.length - 1]!.endTime;
    const now = new Date();
    const diffMs = now.getTime() - lastEnd.getTime();
    const diffDays = diffMs / 86_400_000;
    // Data ends within roughly the last 2 days
    return diffDays < 2 ? 1 : 0;
  }, [records]);

  const circadianAnalysis = useMemo(
    () => analyzeCircadian(records, forecastDays),
    [records, forecastDays],
  );

  // Compute the number of calendar days spanned by the data (for row height limit)
  const daySpan = useMemo(() => {
    if (records.length === 0) return 0;
    const first = records[0]!.startTime.getTime();
    const last = records[records.length - 1]!.endTime.getTime();
    return Math.ceil((last - first) / 86_400_000) + 1;
  }, [records]);

  // Max row height that won't overflow the canvas
  const maxRowHeight = useMemo(() => {
    if (daySpan === 0) return 32;
    return Math.min(32, Math.floor((MAX_CANVAS_HEIGHT - ACTOGRAM_MARGINS) / daySpan));
  }, [daySpan]);

  // Clamp rowHeight if it exceeds the new max (e.g., after loading more data)
  const effectiveRowHeight = Math.min(rowHeight, maxRowHeight);

  // Cumulative phase shift in days and average sleep per day
  const cumulativeShiftDays = useMemo(() => {
    if (daySpan === 0 || circadianAnalysis.globalDailyDrift === 0) return 0;
    return (circadianAnalysis.globalDailyDrift * daySpan) / 24;
  }, [circadianAnalysis.globalDailyDrift, daySpan]);

  const avgSleepPerDay = useMemo(() => {
    if (records.length === 0 || daySpan === 0) return 0;
    const totalHours = records.reduce((sum, r) => sum + r.durationHours, 0);
    return totalHours / daySpan;
  }, [records, daySpan]);

  // Fetch all data from Fitbit API (progressive: renders after each page)
  const handleFetch = useCallback(async () => {
    if (!token) return;
    const abortController = new AbortController();
    fetchAbortRef.current = abortController;
    setFetching(true);
    setFetchProgress("Starting...");
    rawRecordsRef.current = [];
    setRecords([]);
    try {
      await fetchAllSleepRecords(
        token,
        (pageRecords, totalSoFar, page) => {
          rawRecordsRef.current.push(...pageRecords);
          const parsed = parseApiRecords(pageRecords);
          appendRecords(parsed);
          setFetchProgress(`Page ${page}: ${totalSoFar} records...`);
        },
        abortController.signal,
      );
      setFetchProgress(`Done: ${rawRecordsRef.current.length} records loaded`);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setFetchProgress(`Stopped: ${rawRecordsRef.current.length} records kept`);
      } else {
        setFetchProgress(
          `Error: ${err instanceof Error ? err.message : "Fetch failed"}`,
        );
      }
    } finally {
      setFetching(false);
      fetchAbortRef.current = null;
    }
  }, [token, setRecords, appendRecords]);

  const handleStopFetch = useCallback(() => {
    fetchAbortRef.current?.abort();
  }, []);

  // Export raw API data as JSON (round-trips cleanly with import)
  const handleExport = useCallback(() => {
    // If we have raw API records from a fetch, export those.
    // Otherwise export in a wrapper so import can detect the format.
    const exportData =
      rawRecordsRef.current.length > 0
        ? { sleep: rawRecordsRef.current }
        : { sleep: records };
    const data = JSON.stringify(exportData, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fitbit-sleep-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [records]);

  // Import from file
  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        importFromFile(file);
      }
      // Reset input so the same file can be re-imported
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [importFromFile],
  );

  const hasClientId = !!import.meta.env.VITE_FITBIT_CLIENT_ID;

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-lg text-gray-400">Loading sleep data...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4">
      <header className="mx-auto mb-4 max-w-5xl">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-100">
            N24 Sleep Visualization
          </h1>
          <a
            href="https://github.com/Aozora7/fitbit-n24"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-500 hover:text-gray-300"
            title="View on GitHub"
          >
            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
          <button
            onClick={() => setShowPrivacy(true)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            Privacy
          </button>
        </div>
        <p className="mt-1 text-sm text-gray-400">
          {records.length} sleep records
          {circadianAnalysis.globalTau !== 24 && (
            <>
              {" "}&middot; Estimated period:{" "}
              <span className="font-mono text-purple-400">
                τ = {circadianAnalysis.globalTau.toFixed(2)}h
              </span>
              {" "}(drift: {circadianAnalysis.globalDailyDrift > 0 ? "+" : ""}
              {(circadianAnalysis.globalDailyDrift * 60).toFixed(1)} min/day)
              {" "}&middot; Cumulative shift:{" "}
              {cumulativeShiftDays >= 0 ? "+" : ""}
              {cumulativeShiftDays.toFixed(1)} days over {daySpan} days
              {" "}&middot; Avg sleep: {avgSleepPerDay.toFixed(1)}h/day
            </>
          )}
        </p>
        {error && <p className="mt-1 text-sm text-red-400">Data: {error}</p>}
        {authError && (
          <p className="mt-1 text-sm text-red-400">Auth: {authError}</p>
        )}
        {showPrivacy && (
          <div className="mt-3 rounded border border-gray-700 bg-gray-800/80 p-4 text-sm text-gray-300">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-gray-100">Privacy Policy</span>
              <button onClick={() => setShowPrivacy(false)} className="text-gray-400 hover:text-gray-200">&times;</button>
            </div>
            <p className="mb-2">
              This app runs entirely in your browser. Your sleep data is never sent to any server
              controlled by the app developer. When you sign in with Fitbit, the data goes directly
              from Fitbit to your browser. Nothing is stored anywhere except on your own device.
            </p>
            <details className="text-gray-400">
              <summary className="cursor-pointer text-gray-300 hover:text-gray-100">Technical details</summary>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                <li>Static client-side SPA with no backend server, database, or analytics.</li>
                <li>OAuth 2.0 PKCE flow — access token stored in <code className="text-gray-300">sessionStorage</code>, cleared when you close the tab.</li>
                <li>All API requests go directly from your browser to <code className="text-gray-300">api.fitbit.com</code>. No proxy involved.</li>
                <li>No cookies, tracking pixels, or third-party scripts.</li>
                <li>Revoke access anytime at <a href="https://www.fitbit.com/settings/applications" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">fitbit.com/settings/applications</a>.</li>
              </ul>
            </details>
          </div>
        )}
      </header>

      {/* Data source toolbar */}
      <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-3">
        {/* Auth */}
        {hasClientId && (
          <>
            {token ? (
              <>
                <button
                  onClick={fetching ? handleStopFetch : handleFetch}
                  className={`rounded px-3 py-1.5 text-sm text-white ${
                    fetching
                      ? "bg-red-700 hover:bg-red-600"
                      : "bg-green-700 hover:bg-green-600"
                  }`}
                >
                  {fetching ? "Stop" : "Fetch from Fitbit"}
                </button>
                <button
                  onClick={signOut}
                  className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                >
                  Sign out
                </button>
              </>
            ) : (
              <button
                onClick={signIn}
                disabled={authLoading}
                className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {authLoading ? "Authenticating..." : "Sign in with Fitbit"}
              </button>
            )}
          </>
        )}

        {/* Import */}
        <label className="cursor-pointer rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
          Import JSON
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            className="hidden"
          />
        </label>

        {/* Export */}
        {records.length > 0 && (
          <button
            onClick={handleExport}
            className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
          >
            Export JSON
          </button>
        )}

        {fetchProgress && (
          <span className="text-xs text-gray-500">{fetchProgress}</span>
        )}
      </div>

      {records.length > 0 && (
        <>
          {/* Visualization controls */}
          <div className="mx-auto mb-4 flex max-w-5xl gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={doublePlot}
                onChange={(e) => setDoublePlot(e.target.checked)}
                className="rounded"
              />
              Double plot (48h)
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <input
                type="checkbox"
                checked={showCircadian}
                onChange={(e) => setShowCircadian(e.target.checked)}
                className="rounded"
              />
              Show circadian overlay
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              Color:
              <select
                value={colorMode}
                onChange={(e) => setColorMode(e.target.value as ColorMode)}
                className="rounded bg-gray-700 px-2 py-0.5 text-sm text-gray-300"
              >
                <option value="stages">Sleep stages</option>
                <option value="quality">Quality (red→green)</option>
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              Row height:
              <input
                type="range"
                min={2}
                max={maxRowHeight}
                value={effectiveRowHeight}
                onChange={(e) => setRowHeight(Number(e.target.value))}
                className="w-24"
              />
              <span className="font-mono text-xs">{effectiveRowHeight}px</span>
            </label>
          </div>

          {/* Actogram */}
          <div className="mx-auto max-w-5xl">
            <Actogram
              records={records}
              circadian={showCircadian ? circadianAnalysis.days : []}
              doublePlot={doublePlot}
              rowHeight={effectiveRowHeight}
              colorMode={colorMode}
              forecastDays={forecastDays}
            />
          </div>

          {/* Legend */}
          <div className="mx-auto mt-4 flex max-w-5xl flex-wrap gap-6 text-xs text-gray-400">
            {colorMode === "quality" ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "hsl(0, 75%, 45%)" }} />
                  Poor
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "hsl(60, 75%, 45%)" }} />
                  Fair
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "hsl(120, 75%, 45%)" }} />
                  Good
                </div>
              </>
            ) : records.some((r) => r.stageData) ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "#1e40af" }} />
                  Deep
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "#60a5fa" }} />
                  Light
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm" style={{ background: "#06b6d4" }} />
                  REM
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
                  Wake
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-blue-500" />
                  Asleep
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-yellow-500" />
                  Restless
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 rounded-sm bg-red-500" />
                  Awake
                </div>
              </>
            )}
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-3 w-3 rounded-sm bg-purple-500/25" />
              Estimated circadian night
            </div>
          </div>
        </>
      )}
    </div>
  );
}
