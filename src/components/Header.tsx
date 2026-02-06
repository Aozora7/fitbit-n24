import { useState } from "react";
import { useAppContext } from "../AppContext";

export default function Header() {
    const { data, auth, filteredRecords, circadianAnalysis, daySpan, cumulativeShiftDays, avgSleepPerDay, avgTimeInBedPerDay } = useAppContext();
    const [showPrivacy, setShowPrivacy] = useState(false);
    const isFiltered = filteredRecords.length !== data.records.length;

    return (
        <header className="mx-auto mb-4 max-w-5xl">
            <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold text-gray-100">N24 Sleep Visualization</h1>
                <a
                    href="https://github.com/Aozora7/fitbit-n24"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-gray-500 hover:text-gray-300"
                    title="View on GitHub"
                >
                    <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                    </svg>
                </a>
                <button onClick={() => setShowPrivacy(!showPrivacy)} className="text-xs text-gray-500 hover:text-gray-300">
                    Privacy
                </button>
            </div>
            <p className="mt-1 text-sm text-gray-400">
                {isFiltered ? `${filteredRecords.length} of ${data.records.length} sleep records (filtered)` : `${data.records.length} sleep records`}
                {circadianAnalysis.globalTau !== 24 && (
                    <>
                        {" "}
                        &middot; Estimated period: <span className="font-mono text-purple-400">τ = {circadianAnalysis.globalTau.toFixed(2)}h</span> (drift:{" "}
                        {circadianAnalysis.globalDailyDrift > 0 ? "+" : ""}
                        {(circadianAnalysis.globalDailyDrift * 60).toFixed(1)} min/day) &middot; Cumulative shift: {cumulativeShiftDays >= 0 ? "+" : ""}
                        {cumulativeShiftDays.toFixed(1)} days over {daySpan} days &middot; Avg sleep: {avgSleepPerDay.toFixed(1)}h/day &middot; Time in bed:{" "}
                        {avgTimeInBedPerDay.toFixed(1)}h/day
                    </>
                )}
            </p>
            {data.error && <p className="mt-1 text-sm text-red-400">Data: {data.error}</p>}
            {auth.error && <p className="mt-1 text-sm text-red-400">Auth: {auth.error}</p>}
            {showPrivacy && <Privacy onClose={() => setShowPrivacy(false)} />}
        </header>
    );
}

const Privacy = ({ onClose }: { onClose: () => void }) => (
    <div className="mt-3 rounded border border-gray-700 bg-gray-800/80 p-4 text-sm text-gray-300">
        <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-gray-100">Privacy Policy</span>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
                &times;
            </button>
        </div>
        <p className="mb-2">
            This app runs entirely in your browser. Your sleep data is never sent to any server controlled by the app developer. When you sign in with Fitbit,
            the data goes directly from Fitbit to your browser. Nothing is stored anywhere except on your own device.
        </p>
        <details className="text-gray-400">
            <summary className="cursor-pointer text-gray-300 hover:text-gray-100">Technical details</summary>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                <li>Static client-side SPA with no backend server, database, or analytics.</li>
                <li>
                    OAuth 2.0 PKCE flow — access token stored in <code className="text-gray-300">sessionStorage</code>, cleared when you close the tab.
                </li>
                <li>
                    All API requests go directly from your browser to <code className="text-gray-300">api.fitbit.com</code>. No proxy involved.
                </li>
                <li>No cookies, tracking pixels, or third-party scripts.</li>
                <li>
                    Revoke access anytime at{" "}
                    <a href="https://www.fitbit.com/settings/applications" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
                        fitbit.com/settings/applications
                    </a>
                    .
                </li>
            </ul>
        </details>
    </div>
);
