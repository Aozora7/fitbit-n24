import { useState, useMemo, useCallback, useRef } from "react";
import { useSleepData, parseApiRecords } from "./data/useSleepData";
import { useAuth } from "./auth/useAuth";
import { analyzeCircadian } from "./models/circadian";
import { fetchAllSleepRecords } from "./api/sleepApi";
import type { RawSleepRecordV12 } from "./api/types";
import Actogram from "./components/Actogram/Actogram";

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
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Keep raw API records for export
  const rawRecordsRef = useRef<RawSleepRecordV12[]>([]);

  const circadianAnalysis = useMemo(
    () => analyzeCircadian(records),
    [records],
  );

  // Fetch all data from Fitbit API (progressive: renders after each page)
  const handleFetch = useCallback(async () => {
    if (!token) return;
    setFetching(true);
    setFetchProgress("Starting...");
    rawRecordsRef.current = [];
    setRecords([]);
    try {
      await fetchAllSleepRecords(token, (pageRecords, totalSoFar, page) => {
        rawRecordsRef.current.push(...pageRecords);
        const parsed = parseApiRecords(pageRecords);
        appendRecords(parsed);
        setFetchProgress(`Page ${page}: ${totalSoFar} records...`);
      });
      setFetchProgress(`Done: ${rawRecordsRef.current.length} records loaded`);
    } catch (err: unknown) {
      setFetchProgress(
        `Error: ${err instanceof Error ? err.message : "Fetch failed"}`,
      );
    } finally {
      setFetching(false);
    }
  }, [token, setRecords, appendRecords]);

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
        <h1 className="text-2xl font-bold text-gray-100">
          N24 Sleep Visualization
        </h1>
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
              {" "}&middot; Median residual:{" "}
              {(circadianAnalysis.medianResidualHours * 60).toFixed(0)} min
              {" "}&middot; Anchors: {circadianAnalysis.anchorCount}
              {" "}({circadianAnalysis.anchorTierCounts.A}A
              /{circadianAnalysis.anchorTierCounts.B}B
              /{circadianAnalysis.anchorTierCounts.C}C)
            </>
          )}
        </p>
        {error && <p className="mt-1 text-sm text-red-400">Data: {error}</p>}
        {authError && (
          <p className="mt-1 text-sm text-red-400">Auth: {authError}</p>
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
                  onClick={handleFetch}
                  disabled={fetching}
                  className="rounded bg-green-700 px-3 py-1.5 text-sm text-white hover:bg-green-600 disabled:opacity-50"
                >
                  {fetching ? "Fetching..." : "Fetch from Fitbit"}
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
          Row height:
          <input
            type="range"
            min={2}
            max={16}
            value={rowHeight}
            onChange={(e) => setRowHeight(Number(e.target.value))}
            className="w-24"
          />
          <span className="font-mono text-xs">{rowHeight}px</span>
        </label>
      </div>

      {/* Actogram */}
      <div className="mx-auto max-w-5xl">
        <Actogram
          records={records}
          circadian={showCircadian ? circadianAnalysis.days : []}
          doublePlot={doublePlot}
          rowHeight={rowHeight}
        />
      </div>

      {/* Legend */}
      <div className="mx-auto mt-4 flex max-w-5xl flex-wrap gap-6 text-xs text-gray-400">
        {/* Show stage colors if any records have stages */}
        {records.some((r) => r.stageData) ? (
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
    </div>
  );
}
