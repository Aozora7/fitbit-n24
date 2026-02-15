import { useContext } from "react";
import { AppContext } from "./AppContextDef";
import type { AppState } from "./AppContextDef";

export function useAppContext(): AppState {
    const ctx = useContext(AppContext);
    if (!ctx) throw new Error("useAppContext must be used inside <AppProvider>");
    return ctx;
}
