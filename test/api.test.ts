import { describe, expect, test } from "bun:test";
import { ApiClient, ApiConnectionError, ApiRequestError, isRetryableError } from "../src/lib/api.ts";

/** A fetch that replays a scripted sequence of outcomes; records every attempt. */
function scripted(steps: Array<number | "timeout" | "refused">) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === "timeout") {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (step === "refused") throw new Error("connect ECONNREFUSED");
    if (step === 200) return new Response(JSON.stringify({ ok: true, n: calls.length }), { status: 200 });
    return new Response(JSON.stringify({ error: `boom ${step}` }), { status: step });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const sleeps: number[] = [];
const sleepImpl = async (ms: number) => { sleeps.push(ms); };
const base = { apiBase: "http://stub.invalid", retryBaseMs: 100, sleepImpl };

describe("ApiClient retry", () => {
  test("retries 503 then succeeds; backoff doubles", async () => {
    sleeps.length = 0;
    const s = scripted([503, 503, 200]);
    const api = new ApiClient({ ...base, fetchImpl: s.fetchImpl, retries: 3 });
    const r = await api.get<{ n: number }>("/api/health");
    expect(r.n).toBe(3);
    expect(s.calls).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  test("retries connection refusal and request timeout", async () => {
    const s = scripted(["refused", "timeout", 200]);
    const api = new ApiClient({ ...base, fetchImpl: s.fetchImpl, retries: 2, timeoutMs: 20 });
    const r = await api.get<{ n: number }>("/x");
    expect(r.n).toBe(3);
  });

  test("gives up after retries and surfaces the last error", async () => {
    const s = scripted([503]);
    const api = new ApiClient({ ...base, fetchImpl: s.fetchImpl, retries: 2 });
    await expect(api.get("/x")).rejects.toBeInstanceOf(ApiRequestError);
    expect(s.calls).toHaveLength(3); // 1 + 2 retries
  });

  test("never retries 401/403/404 — those are answers, not outages", async () => {
    for (const code of [401, 403, 404]) {
      const s = scripted([code, 200]);
      const api = new ApiClient({ ...base, fetchImpl: s.fetchImpl, retries: 3 });
      await expect(api.get("/x")).rejects.toMatchObject({ status: code });
      expect(s.calls).toHaveLength(1);
    }
  });

  test("retries: 0 disables retry entirely", async () => {
    const s = scripted(["refused", 200]);
    const api = new ApiClient({ ...base, fetchImpl: s.fetchImpl, retries: 0 });
    await expect(api.get("/x")).rejects.toBeInstanceOf(ApiConnectionError);
    expect(s.calls).toHaveLength(1);
  });

  test("isRetryableError classifies", () => {
    expect(isRetryableError(new ApiConnectionError("u", "timeout"))).toBe(true);
    expect(isRetryableError(new ApiRequestError(429, "slow down", "u"))).toBe(true);
    expect(isRetryableError(new ApiRequestError(500, "x", "u"))).toBe(true);
    expect(isRetryableError(new ApiRequestError(400, "x", "u"))).toBe(false);
    expect(isRetryableError(new Error("random"))).toBe(false);
  });
});
