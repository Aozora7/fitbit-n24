import { useState, useCallback } from "react";

export function usePersistedState<T>(key: string, defaultValue: T) {
    const [value, setValue] = useState<T>(() => {
        try {
            const stored = localStorage.getItem(key);
            return stored !== null ? (JSON.parse(stored) as T) : defaultValue;
        } catch {
            return defaultValue;
        }
    });
    const setAndPersist = useCallback(
        (v: T | ((prev: T) => T)) => {
            setValue((prev) => {
                const next = typeof v === "function" ? (v as (prev: T) => T)(prev) : v;
                try {
                    localStorage.setItem(key, JSON.stringify(next));
                } catch {
                    /* quota exceeded */
                }
                return next;
            });
        },
        [key]
    );
    return [value, setAndPersist] as const;
}
