import { useRef, useCallback } from "react";
import { useAppContext } from "../useAppContext";
import type { OverlayControlPoint } from "../models/overlayPath";
import { exportActogramPNG } from "../utils/exportPNG";

export default function DataToolbar() {
    const {
        data,
        auth,
        hasClientId,
        handleFetch,
        overlayControlPoints,
        setOverlayControlPoints,
        manualOverlayDays,
        filteredRecords,
        circadianAnalysis,
        daySpan,
        colorMode,
        showPeriodogram,
    } = useAppContext();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = useCallback(
        async (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (!file) return;

            // Read the file to check for overlay before passing to importFromFile
            const text = await file.text();
            const json = JSON.parse(text);
            if (json.controlPoints && Array.isArray(json.controlPoints)) {
                setOverlayControlPoints(json.controlPoints as OverlayControlPoint[]);
            }

            // Re-create the file blob for importFromFile (it reads the file independently)
            const blob = new Blob([text], { type: "application/json" });
            const reimported = new File([blob], file.name, { type: file.type });
            await data.importFromFile(reimported);

            if (fileInputRef.current) fileInputRef.current.value = "";
        },
        [data.importFromFile, setOverlayControlPoints],
    );

    return (
        <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-3">
            {hasClientId && (
                <>
                    {auth.token ? (
                        <>
                            <button
                                onClick={data.fetching ? data.stopFetch : handleFetch}
                                className={`rounded px-3 py-1.5 text-sm text-white ${
                                    data.fetching ? "bg-red-700 hover:bg-red-600" : "bg-green-700 hover:bg-green-600"
                                }`}
                            >
                                {data.fetching ? "Stop" : "Fetch from Fitbit"}
                            </button>
                            <button
                                onClick={auth.signOut}
                                className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                            >
                                Sign out
                            </button>
                            {auth.userId && (
                                <button
                                    onClick={() => data.clearCache(auth.userId!)}
                                    className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                                >
                                    Clear cache
                                </button>
                            )}
                        </>
                    ) : (
                        <button
                            onClick={auth.signIn}
                            disabled={auth.loading}
                            className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                            {auth.loading ? "Authenticating..." : "Sign in with Fitbit"}
                        </button>
                    )}
                </>
            )}

            <label className="cursor-pointer rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
                Import JSON
                <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileChange} className="hidden" />
            </label>

            {data.records.length > 0 && (
                <button
                    onClick={data.exportToFile}
                    className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                >
                    Export JSON
                </button>
            )}

            {data.records.length > 0 && (
                <button
                    onClick={() =>
                        exportActogramPNG(
                            {
                                recordCount: filteredRecords.length,
                                tau: circadianAnalysis.tau,
                                drift: circadianAnalysis.dailyDrift,
                                rSquared: circadianAnalysis.rSquared,
                                daySpan,
                                algorithmId: circadianAnalysis.algorithmId,
                                colorMode,
                            },
                            { includePeriodogram: showPeriodogram },
                        )
                    }
                    className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                >
                    Save as PNG
                </button>
            )}

            {data.records.length > 0 && overlayControlPoints.length > 0 && (
                <button
                    onClick={() => {
                        const exportData = {
                            sleep: data.records,
                            overlay: manualOverlayDays,
                            controlPoints: overlayControlPoints,
                        };
                        const json = JSON.stringify(exportData, null, 2);
                        const blob = new Blob([json], { type: "application/json" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `fitbit-sleep-overlay-${new Date().toISOString().slice(0, 10)}.json`;
                        a.click();
                        URL.revokeObjectURL(url);
                    }}
                    className="rounded bg-cyan-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-cyan-700"
                >
                    Export with overlay
                </button>
            )}

            {data.fetchProgress && <span className="text-xs text-gray-500">{data.fetchProgress}</span>}
        </div>
    );
}
