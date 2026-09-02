/**
 * Minimal read-only Paperclip API client. GET only — by construction this
 * module cannot mutate anything upstream.
 */
export class ApiRequestError extends Error {
  constructor(public readonly status: number, message: string, public readonly url: string) {
    super(message);
  }
}

export class ApiConnectionError extends Error {
  constructor(public readonly url: string, public readonly cause_: string) {
    super(`Could not reach the Paperclip API at ${url}: ${cause_}`);
  }
}

export interface ApiClientOptions {
  apiBase: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PaperclipReader {
  get<T>(path: string): Promise<T>;
}

export class ApiClient implements PaperclipReader {
  readonly apiBase: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  buildUrl(p: string): string {
    const normalized = p.startsWith("/") ? p : `/${p}`;
    const [pathname, query] = normalized.split("?");
    const url = new URL(this.apiBase);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${pathname}`;
    if (query) url.search = query;
    return url.toString();
  }

  async get<T>(p: string): Promise<T> {
    const url = this.buildUrl(p);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: "GET", headers, signal: ac.signal });
    } catch (err) {
      const msg = err instanceof Error ? (err.name === "AbortError" ? `timeout after ${this.timeoutMs}ms` : err.message) : String(err);
      throw new ApiConnectionError(url, msg);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = `Request failed with status ${res.status}`;
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        if (typeof body.error === "string" && body.error.trim()) message = body.error.trim();
        else if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
      } catch { /* non-JSON body */ }
      throw new ApiRequestError(res.status, message, url);
    }
    if (res.status === 204) return null as T;
    const text = await res.text();
    if (!text.trim()) return null as T;
    return JSON.parse(text) as T;
  }
}

export function apiPath(strings: TemplateStringsArray, ...values: Array<string | number>): string {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    if (v === null || v === undefined || String(v).trim() === "") throw new Error("Cannot build API path with an empty segment.");
    out += `${encodeURIComponent(String(v))}${strings[i + 1] ?? ""}`;
  });
  return out;
}

/** Human-friendly one-liner for stderr. */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiRequestError) return `API error ${err.status}: ${err.message}`;
  if (err instanceof ApiConnectionError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
