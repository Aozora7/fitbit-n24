import { useAppContext } from "../useAppContext";

export default function Legend() {
    const { colorMode, filteredRecords } = useAppContext();
    const hasStages = filteredRecords.some((r) => r.stageData);

    return (
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
                        <span
                            className="inline-block h-3 w-3 rounded-sm"
                            style={{ background: "hsl(120, 75%, 45%)" }}
                        />
                        Good
                    </div>
                </>
            ) : hasStages ? (
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
    );
}
