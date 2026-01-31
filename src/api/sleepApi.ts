import { fitbitFetch } from "./fitbit";
import type { FitbitSleepPageV12, RawSleepRecordV12 } from "./types";

/**
 * Fetch all sleep records from the Fitbit API v1.2 endpoint.
 * Paginates automatically until all data is retrieved.
 * Calls onPageData with each page's records so the UI can render progressively.
 *
 * @param token - OAuth access token
 * @param onPageData - Callback with each page's records and running total
 */
export async function fetchAllSleepRecords(
  token: string,
  onPageData?: (pageRecords: RawSleepRecordV12[], totalSoFar: number, page: number) => void,
): Promise<RawSleepRecordV12[]> {
  const allRecords: RawSleepRecordV12[] = [];
  let page = 0;

  // Start from tomorrow to capture today's sleep
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  let nextPath = `/1.2/user/-/sleep/list.json?beforeDate=${tomorrow.toISOString().slice(0, 10)}&sort=desc&offset=0&limit=100`;

  while (nextPath) {
    const data = await fitbitFetch<FitbitSleepPageV12>(nextPath, token);
    page++;

    if (data.sleep && data.sleep.length > 0) {
      allRecords.push(...data.sleep);
      onPageData?.(data.sleep, allRecords.length, page);
    }

    // Follow pagination cursor
    if (data.pagination?.next) {
      try {
        const nextUrl = new URL(data.pagination.next);
        nextPath = nextUrl.pathname + nextUrl.search;
      } catch {
        nextPath = "";
      }
    } else {
      nextPath = "";
    }
  }

  return allRecords;
}
