const FITBIT_AUTH_URL = "https://www.fitbit.com/oauth2/authorize";
const FITBIT_TOKEN_URL = "https://api.fitbit.com/oauth2/token";
const SCOPES = "sleep";

function getClientId(): string {
  const id = import.meta.env.VITE_FITBIT_CLIENT_ID as string | undefined;
  if (!id) throw new Error("VITE_FITBIT_CLIENT_ID is not set in .env");
  return id;
}

function getRedirectUri(): string {
  return window.location.origin + "/";
}

/** Generate a cryptographically random string for PKCE code_verifier */
function generateVerifier(length = 128): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(values, (v) => chars[v % chars.length]).join("");
}

/** Compute SHA-256 hash and return as base64url */
async function computeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Start the OAuth PKCE authorization flow.
 * Generates a verifier, stores it, and redirects to Fitbit.
 */
export async function startAuth(): Promise<void> {
  const verifier = generateVerifier();
  localStorage.setItem("pkce_verifier", verifier);

  const challenge = await computeChallenge(verifier);
  const clientId = getClientId();
  const redirectUri = getRedirectUri();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  window.location.href = `${FITBIT_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code for an access token.
 * Called after the OAuth redirect with ?code=... in the URL.
 */
export async function exchangeCode(
  code: string,
): Promise<{ accessToken: string; expiresIn: number; userId: string }> {
  const verifier = localStorage.getItem("pkce_verifier");
  if (!verifier) throw new Error("No PKCE verifier found in session");

  const clientId = getClientId();
  const redirectUri = getRedirectUri();

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });

  const response = await fetch(FITBIT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    user_id: string;
  };
  localStorage.removeItem("pkce_verifier");

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    userId: data.user_id,
  };
}
