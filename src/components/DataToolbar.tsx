import { useRef, useCallback } from "react";
import { useAppContext } from "../AppContext";

export default function DataToolbar() {
    const { data, auth, hasClientId, handleFetch } = useAppContext();
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) data.importFromFile(file);
            if (fileInputRef.current) fileInputRef.current.value = "";
        },
        [data.importFromFile]
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
                            <button onClick={auth.signOut} className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
                                Sign out
                            </button>
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
                <button onClick={data.exportToFile} className="rounded bg-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-600">
                    Export JSON
                </button>
            )}

            {data.fetchProgress && <span className="text-xs text-gray-500">{data.fetchProgress}</span>}
        </div>
    );
}
