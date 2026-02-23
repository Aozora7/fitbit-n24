import { createContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { startAuth, exchangeCode, refreshAccessToken, type TokenResult } from "./oauth";

const STORAGE_TOKEN = "fitbit_token";
const STORAGE_USER_ID = "fitbit_user_id";
const STORAGE_REFRESH_TOKEN = "fitbit_refresh_token";
const STORAGE_TOKEN_EXPIRY = "fitbit_token_expiry"; // epoch ms

/** Minutes before expiry at which we proactively refresh */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

function readStorage() {
    return {
        token: localStorage.getItem(STORAGE_TOKEN),
        userId: localStorage.getItem(STORAGE_USER_ID),
        refreshToken: localStorage.getItem(STORAGE_REFRESH_TOKEN),
        expiryMs: Number(localStorage.getItem(STORAGE_TOKEN_EXPIRY) ?? "0"),
    };
}

function writeStorage({ accessToken, refreshToken, expiresIn, userId }: TokenResult) {
    const expiryMs = Date.now() + expiresIn * 1000;
    localStorage.setItem(STORAGE_TOKEN, accessToken);
    localStorage.setItem(STORAGE_USER_ID, userId);
    localStorage.setItem(STORAGE_REFRESH_TOKEN, refreshToken);
    localStorage.setItem(STORAGE_TOKEN_EXPIRY, String(expiryMs));
    return expiryMs;
}

function clearStorage() {
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_USER_ID);
    localStorage.removeItem(STORAGE_REFRESH_TOKEN);
    localStorage.removeItem(STORAGE_TOKEN_EXPIRY);
}

export interface AuthState {
    token: string | null;
    userId: string | null;
    loading: boolean;
    error: string | null;
    signIn: () => Promise<void>;
    signOut: () => void;
}

export const AuthContext = createContext<AuthState>({
    token: null,
    userId: null,
    loading: false,
    error: null,
    signIn: async () => {},
    signOut: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
    const stored = readStorage();
    const [token, setToken] = useState<string | null>(stored.token);
    const [userId, setUserId] = useState<string | null>(stored.userId);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const applyToken = useCallback((result: TokenResult) => {
        const expiryMs = writeStorage(result);
        setToken(result.accessToken);
        setUserId(result.userId);

        // Schedule proactive refresh
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        const delay = Math.max(0, expiryMs - Date.now() - REFRESH_BEFORE_MS);
        refreshTimerRef.current = setTimeout(() => {
            const currentRefresh = localStorage.getItem(STORAGE_REFRESH_TOKEN);
            if (!currentRefresh) return;
            refreshAccessToken(currentRefresh)
                .then(applyToken)
                .catch(() => {
                    // Refresh failed — clear token so user sees sign-in prompt
                    clearStorage();
                    setToken(null);
                    setUserId(null);
                });
        }, delay);
    }, []);

    // On mount: handle OAuth callback OR silently refresh an expired stored token
    useEffect(() => {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");

        if (code) {
            url.searchParams.delete("code");
            window.history.replaceState({}, "", url.pathname);

            setLoading(true);
            exchangeCode(code)
                .then((result) => {
                    applyToken(result);
                    setError(null);
                })
                .catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : "Token exchange failed");
                })
                .finally(() => setLoading(false));
            return;
        }

        // No OAuth code — check whether stored token needs a silent refresh
        const { refreshToken, expiryMs } = readStorage();
        if (refreshToken && Date.now() >= expiryMs - REFRESH_BEFORE_MS) {
            setLoading(true);
            refreshAccessToken(refreshToken)
                .then((result) => {
                    applyToken(result);
                    setError(null);
                })
                .catch(() => {
                    clearStorage();
                    setToken(null);
                    setUserId(null);
                })
                .finally(() => setLoading(false));
        } else if (token && expiryMs) {
            // Token still valid — set up the refresh timer for it
            applyToken({
                accessToken: token,
                expiresIn: Math.round((expiryMs - Date.now()) / 1000),
                refreshToken: refreshToken ?? "",
                userId: userId ?? "",
            });
        }
         
    }, []);

    // Clean up timer on unmount
    useEffect(() => {
        return () => {
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        };
    }, []);

    const signIn = useCallback(async () => {
        try {
            await startAuth();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to start auth");
        }
    }, []);

    const signOut = useCallback(() => {
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        clearStorage();
        setToken(null);
        setUserId(null);
    }, []);

    return (
        <AuthContext.Provider value={{ token, userId, loading, error, signIn, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}
