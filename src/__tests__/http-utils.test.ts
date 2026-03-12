import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { _internals, fetchWithRetry, INITIAL_BACKOFF_MS, MAX_RETRIES } from "../lib/http-utils.js";

// ── Fetch & sleep mock helpers ──────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let fetchMock: Mock;
let sleepMock: Mock;

function mockResponse(status: number, headers: Record<string, string> = {}, body = "{}") {
  fetchMock.mockResolvedValueOnce(
    new Response(body, { status, headers: { "Content-Type": "application/json", ...headers } }),
  );
}

beforeAll(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  sleepMock = vi.fn().mockResolvedValue(undefined);
  _internals.sleep = sleepMock;
});

afterEach(() => {
  fetchMock.mockReset();
  sleepMock.mockReset();
});

describe("fetchWithRetry", () => {
  describe("429 handling", () => {
    it("429 on final attempt does NOT sleep — returns immediately", async () => {
      // Exhaust all retries: attempts 0, 1, 2 get 429 + sleep, attempt 3 (final) gets 429 + NO sleep
      for (let i = 0; i <= MAX_RETRIES; i++) {
        mockResponse(429);
      }

      const res = await fetchWithRetry("https://example.com/api", { label: "Test" });

      // Final attempt returns the 429 response without sleeping (retryDelay returns null)
      expect(res.status).toBe(429);
      expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRIES + 1);
      // Should have slept MAX_RETRIES times (attempts 0..2), NOT on final attempt 3
      expect(sleepMock).toHaveBeenCalledTimes(MAX_RETRIES);
    });

    it("429 on non-final attempt retries correctly", async () => {
      // First attempt: 429
      mockResponse(429);
      // Second attempt: success
      mockResponse(200, {}, JSON.stringify({ ok: true }));

      const res = await fetchWithRetry("https://example.com/api");

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // Should have slept once (exponential backoff for attempt 0)
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(INITIAL_BACKOFF_MS * 1); // 1 << 0 = 1
    });
  });

  describe("Retry-After header parsing", () => {
    it("respects Retry-After header with seconds value", async () => {
      // 429 with Retry-After: 5 (seconds)
      mockResponse(429, { "Retry-After": "5" });
      // Second attempt: success
      mockResponse(200);

      await fetchWithRetry("https://example.com/api");

      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(5000); // 5 seconds -> 5000ms
    });

    it("parses Retry-After header with HTTP-date value", async () => {
      const futureDate = new Date(Date.now() + 3000);
      const httpDate = futureDate.toUTCString(); // e.g. "Thu, 01 Jan 2026 00:00:03 GMT"

      mockResponse(429, { "Retry-After": httpDate });
      mockResponse(200);

      await fetchWithRetry("https://example.com/api");

      expect(sleepMock).toHaveBeenCalledTimes(1);
      const sleepDuration = sleepMock.mock.calls[0]?.[0] as number;
      // Should be approximately 3000ms (allow some tolerance for test execution time)
      expect(sleepDuration).toBeGreaterThan(2000);
      expect(sleepDuration).toBeLessThanOrEqual(3500);
    });

    it("falls back to exponential backoff when Retry-After is invalid", async () => {
      // 429 with invalid Retry-After
      mockResponse(429, { "Retry-After": "not-a-number-or-date" });
      // Second attempt: success
      mockResponse(200);

      await fetchWithRetry("https://example.com/api");

      expect(sleepMock).toHaveBeenCalledTimes(1);
      // Invalid Retry-After -> parseRetryAfter returns 0 -> falsy -> backoffMs(0) = 1000
      expect(sleepMock).toHaveBeenCalledWith(INITIAL_BACKOFF_MS * 1); // backoffMs(0) = 1000 * (1 << 0)
    });
  });
});
