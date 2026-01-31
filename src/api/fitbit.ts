const BASE_URL = "https://api.fitbit.com";

export class FitbitApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "FitbitApiError";
  }
}

/**
 * Typed fetch wrapper for the Fitbit API.
 * Adds Authorization header and handles errors.
 */
export async function fitbitFetch<T>(
  path: string,
  token: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    mode: "cors",
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new FitbitApiError(
      response.status,
      `Fitbit API error ${response.status}: ${text}`,
    );
  }

  return response.json() as Promise<T>;
}
