import { useAppContext } from "./useAppContext";
import Header from "./components/Header";
import DataToolbar from "./components/DataToolbar";
import VisualizationControls from "./components/VisualizationControls";
import ScheduleEditor from "./components/ScheduleEditor";
import Actogram from "./components/Actogram/Actogram";
import Periodogram from "./components/Periodogram";
import PhaseChart from "./components/PhaseChart";
import DateRangeSlider from "./components/DateRangeSlider";
import Legend from "./components/Legend";

export default function App() {
    const { data, showScheduleEditor } = useAppContext();

    if (data.loading) {
        return (
            <div className="flex h-screen items-center justify-center">
                <p className="text-lg text-gray-400">Loading sleep data...</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen p-4">
            <Header />
            <DataToolbar />
            <VisualizationControls />
            {showScheduleEditor && <ScheduleEditor />}
            {data.records.length > 0 && (
                <>
                    <div className="mx-auto max-w-5xl">
                        <DateRangeSlider />
                        <PhaseChart />
                        <Periodogram />
                        <Actogram />
                    </div>

                    <Legend />
                </>
            )}
        </div>
    );
}
