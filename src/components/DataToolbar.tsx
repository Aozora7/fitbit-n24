import { useRef, useCallback } from "react";
import { useAppContext } from "../useAppContext";
import type { OverlayControlPoint } from "../models/overlayPath";
import { exportActogramPNG } from "../utils/exportPNG";
import { RefreshCw, Square, LogIn, LogOut, Trash2, Upload, Download, Image, Construction } from "lucide-react";

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
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const fileArray = Array.from(files).filter((f): f is File => f != null);
            const firstFile = fileArray[0];

            if (firstFile) {
                const text = await firstFile.text();
                const json = JSON.parse(text);

                if (json.controlPoints && Array.isArray(json.controlPoints)) {
                    setOverlayControlPoints(json.controlPoints as OverlayControlPoint[]);
                }
            }

            await data.importFromFiles(fileArray);

            if (fileInputRef.current) fileInputRef.current.value = "";
        },
        [data.importFromFiles, setOverlayControlPoints]
    );

    return (
        <div className="mx-auto mb-4 flex max-w-5xl flex-wrap items-center gap-3">
            {hasClientId && (
                <>
                    {auth.token ? (
                        <>
                            <button
                                onClick={data.fetching ? data.stopFetch : handleFetch}
                                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm text-white ${
                                    data.fetching ? "bg-red-700 hover:bg-red-600" : "bg-green-700 hover:bg-green-600"
                                }`}
                            >
                                {data.fetching ? (
                                    <Square size={14} strokeWidth={3} />
                                ) : (
                                    <RefreshCw size={14} strokeWidth={3} />
                                )}
                                {data.fetching ? "Stop" : "Fetch"}
                            </button>
                            <button
                                onClick={auth.signOut}
                                className="inline-flex items-center gap-1.5 rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                            >
                                <LogOut size={14} strokeWidth={3} />
                                Sign out
                            </button>
                            {auth.userId && (
                                <button
                                    onClick={() => data.clearCache(auth.userId!)}
                                    className="inline-flex items-center gap-1.5 rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                                >
                                    <Trash2 size={14} strokeWidth={3} />
                                    Clear cache
                                </button>
                            )}
                        </>
                    ) : (
                        <button
                            onClick={auth.signIn}
                            disabled={auth.loading}
                            className="inline-flex items-center gap-1.5 rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                            <LogIn size={14} strokeWidth={3} />
                            {auth.loading ? "Authenticating..." : "Sign in"}
                        </button>
                    )}
                </>
            )}

            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
                <Download size={14} strokeWidth={3} />
                Import
                <input
                    ref={fileInputRef}
                    type="file"
                    accept=".json"
                    multiple
                    onChange={handleFileChange}
                    className="hidden"
                />
            </label>

            {data.records.length > 0 && (
                <button
                    onClick={data.exportToFile}
                    className="inline-flex items-center gap-1.5 rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                >
                    <Upload size={14} strokeWidth={3} />
                    Export
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
                            { includePeriodogram: showPeriodogram }
                        )
                    }
                    className="inline-flex items-center gap-1.5 rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600"
                >
                    <Image size={14} strokeWidth={3} />
                    Save PNG
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
                    className="inline-flex items-center gap-1.5 rounded bg-cyan-800 px-3 py-1.5 text-sm text-gray-200 hover:bg-cyan-700"
                >
                    <Construction size={14} strokeWidth={3} />
                    Export overlay
                </button>
            )}

            {data.fetchProgress && <span className="text-xs text-gray-500">{data.fetchProgress}</span>}
        </div>
    );
}
