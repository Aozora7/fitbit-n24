import { useAppContext } from "../useAppContext";
import type { ScheduleEntry } from "../AppContextDef";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

export default function ScheduleEditor() {
    const { scheduleEntries, setScheduleEntries } = useAppContext();

    const addEntry = () => {
        const newEntry: ScheduleEntry = {
            id: crypto.randomUUID(),
            startTime: "09:00",
            endTime: "17:00",
            days: [true, true, true, true, true, false, false], // Mon-Fri default
        };
        setScheduleEntries((prev) => [...prev, newEntry]);
    };

    const updateEntry = (id: string, updates: Partial<Omit<ScheduleEntry, "id">>) => {
        setScheduleEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...updates } : entry)));
    };

    const deleteEntry = (id: string) => {
        setScheduleEntries((prev) => prev.filter((entry) => entry.id !== id));
    };

    const toggleDay = (id: string, dayIndex: number) => {
        setScheduleEntries((prev) =>
            prev.map((entry) => {
                if (entry.id !== id) return entry;
                const newDays = [...entry.days];
                newDays[dayIndex] = !newDays[dayIndex];
                return { ...entry, days: newDays };
            })
        );
    };

    return (
        <div className="mx-auto mb-4 max-w-5xl space-y-2">
            <div className="flex items-center gap-3 text-sm text-gray-300">
                <span className="font-medium">Schedule entries:</span>
                <button
                    onClick={addEntry}
                    className="rounded bg-indigo-600 px-3 py-1 text-xs text-white hover:bg-indigo-500"
                >
                    + Add Entry
                </button>
            </div>

            {scheduleEntries.map((entry) => (
                <div key={entry.id} className="flex flex-wrap items-center gap-3 rounded bg-slate-800 px-3 py-2">
                    <input
                        type="time"
                        value={entry.startTime}
                        onChange={(e) => updateEntry(entry.id, { startTime: e.target.value })}
                        className="rounded bg-gray-700 px-2 py-1 text-sm text-gray-200"
                    />
                    <span className="text-gray-400">–</span>
                    <input
                        type="time"
                        value={entry.endTime}
                        onChange={(e) => updateEntry(entry.id, { endTime: e.target.value })}
                        className="rounded bg-gray-700 px-2 py-1 text-sm text-gray-200"
                    />

                    <div className="flex gap-1">
                        {DAY_LABELS.map((label, i) => (
                            <button
                                key={i}
                                onClick={() => toggleDay(entry.id, i)}
                                className={`h-7 w-7 rounded text-xs font-medium ${
                                    entry.days[i]
                                        ? "bg-green-600 text-white"
                                        : "bg-gray-600 text-gray-400 hover:bg-gray-500"
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>

                    <button
                        onClick={() => deleteEntry(entry.id)}
                        className="ml-auto text-red-400 hover:text-red-300"
                        title="Delete entry"
                    >
                        ✕
                    </button>
                </div>
            ))}

            {scheduleEntries.length === 0 && (
                <p className="text-sm text-gray-500 italic">No schedule entries. Click "Add Entry" to create one.</p>
            )}
        </div>
    );
}
