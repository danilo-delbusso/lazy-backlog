/**
 * Shared HTTP retry/backoff utilities used by Jira and Confluence clients.
 */

export const MAX_RETRIES = 3;
export const INITIAL_BACKOFF_MS = 1_000;
export const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** @internal Exposed for test mocking — do not use directly. */
export const _internals = { sleep };

export interface FetchWithRetryOptions {
  /** HTTP method (GET, POST, PUT, etc.). Defaults to "GET". */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body — will be serialized to JSON if provided. */
  body?: unknown;
  /** Abort timeout in milliseconds. */
  timeoutMs?: number;
  /** Label for error messages (e.g. "Jira", "Confluence"). Defaults to "HTTP". */
  label?: string;
}

/** Compute the backoff delay for a given attempt (exponential). */
function backoffMs(attempt: number): number {
  return INITIAL_BACKOFF_MS * (1 << attempt);
}

/** Determine whether a response should be retried and the delay to wait. */
function retryDelay(res: Response, attempt: number): number | null {
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    return retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : backoffMs(attempt);
  }
  if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
    return backoffMs(attempt);
  }
  return null;
}

/**
 * Fetch with exponential backoff retry for 429 and 5xx responses.
 *
 * Returns the raw Response on success (including non-retryable error statuses
 * like 4xx). Callers are responsible for checking `res.ok` and parsing.
 *
 * Throws only after all retries are exhausted for retryable statuses, or on
 * network/timeout errors that persist across retries.
 */
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const { method = "GET", headers, body, timeoutMs = 15_000, label = "HTTP" } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      // Network or timeout error — retry if attempts remain
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await _internals.sleep(backoffMs(attempt));
        continue;
      }
      throw lastError;
    }

    const delay = retryDelay(res, attempt);
    if (delay != null) {
      lastError = new Error(`${label} ${res.status} ${method} ${url}`);
      await _internals.sleep(delay);
      continue;
    }

    return res;
  }

  throw lastError ?? new Error(`${label} request failed after retries: ${method} ${url}`);
}
