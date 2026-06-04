import { useAppContext } from "../useAppContext";

export default function DeprecationAlert() {
    const { deprecationAlertDismissed, setDeprecationAlertDismissed } = useAppContext();

    if (deprecationAlertDismissed) return null;

    return (
        <div className="mx-auto mb-4 max-w-5xl rounded border border-amber-600/60 bg-amber-950/40 p-4 text-sm text-gray-300">
            <div className="mb-2 flex items-center justify-between">
                <span className="font-semibold text-amber-400">
                    <svg
                        className="mr-1.5 inline h-4 w-4 -translate-y-px"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden="true"
                    >
                        <path
                            fillRule="evenodd"
                            d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.168 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 6a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 6Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                            clipRule="evenodd"
                        />
                    </svg>
                    Fitbit Web API is being shut down
                </span>
                <button
                    onClick={() => setDeprecationAlertDismissed(true)}
                    className="rounded border border-amber-600/50 bg-amber-900/40 px-3 py-1 text-xs text-amber-300 hover:bg-amber-800/50"
                >
                    Dismiss
                </button>
            </div>
            <p className="mb-2">
                The legacy Fitbit Web API will be decommissioned in <strong>September 2026</strong>. After that, this
                app will stop functioning because it relies on the Fitbit API to fetch sleep data. You can read Google's
                announcement{" "}
                <a
                    href="https://support.google.com/googlehealth/thread/434943730?hl=en&sjid=1351675237833757096-EU"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-amber-400 underline hover:text-amber-300"
                >
                    here
                </a>
                .
            </p>
            <p>
                A new version of this app using the Google Health API is available at{" "}
                <a
                    href="https://25h.aozora.one/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-amber-400 underline hover:text-amber-300"
                >
                    25h.aozora.one
                </a>
                . All of your existing data should already be available there, and you can log in with the same Google
                account.
            </p>
        </div>
    );
}
