import { createContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { startAuth, exchangeCode } from "./oauth";

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
    const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("fitbit_token"));
    const [userId, setUserId] = useState<string | null>(() => sessionStorage.getItem("fitbit_user_id"));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Handle OAuth callback on mount
    useEffect(() => {
        const url = new URL(window.location.href);
        const code = url.searchParams.get("code");
        if (!code) return;

        // Clear the code from URL
        url.searchParams.delete("code");
        window.history.replaceState({}, "", url.pathname);

        setLoading(true);
        exchangeCode(code)
            .then(({ accessToken, userId: uid }) => {
                sessionStorage.setItem("fitbit_token", accessToken);
                sessionStorage.setItem("fitbit_user_id", uid);
                setToken(accessToken);
                setUserId(uid);
                setError(null);
            })
            .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Token exchange failed");
            })
            .finally(() => setLoading(false));
    }, []);

    const signIn = useCallback(async () => {
        try {
            await startAuth();
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : "Failed to start auth");
        }
    }, []);

    const signOut = useCallback(() => {
        sessionStorage.removeItem("fitbit_token");
        sessionStorage.removeItem("fitbit_user_id");
        setToken(null);
        setUserId(null);
    }, []);

    return (
        <AuthContext.Provider value={{ token, userId, loading, error, signIn, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}
