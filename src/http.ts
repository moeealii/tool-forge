import { appendFile } from "node:fs/promises";
import { applyAuth, type Auth, secretQueryNames } from "./auth.js";
import { isObject, type Json } from "./spec.js";
import type { Method, ToolDef } from "./tools.js";

export interface ExecutorOptions {
  baseUrl: string;
  auth: Auth[];
  /** Extra static headers sent with every request, e.g. a User-Agent. */
  headers?: Record<string, string>;
  /** Sustained requests per second across all tools; 0 disables limiting. */
  rps: number;
  burst: number;
  /** Attempts after the first one. */
  retries: number;
  timeoutMs: number;
  /** Responses longer than this many characters are cut, with a note saying so. */
  maxResponseChars: number;
  auditPath?: string;
  /** Overridable for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_EXECUTOR = {
  rps: 5,
  burst: 10,
  retries: 3,
  timeoutMs: 30_000,
  maxResponseChars: 50_000,
} satisfies Partial<ExecutorOptions>;

export interface PreparedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body?: string;
}

export interface CallResult {
  ok: boolean;
  status?: number;
  text: string;
  attempts: number;
}

const IDEMPOTENT = new Set<Method>(["get", "head", "options", "put", "delete"]);
const RETRY_STATUS = new Set([502, 503, 504]);
const SECRET_NAME = /pass(word)?|secret|token|api[-_]?key|^key$|signature|^sig$|credential|auth/i;

export class ArgumentError extends Error {}

/** Build the HTTP request for one tool call, without auth, without sending it. */
export function prepareRequest(tool: ToolDef, args: Record<string, unknown>, baseUrl: string): PreparedRequest {
  const unknownArgs = Object.keys(args).filter(
    (k) => k !== "body" && !tool.params.some((p) => p.arg === k),
  );
  if (unknownArgs.length) throw new ArgumentError(`unknown argument(s): ${unknownArgs.join(", ")}`);

  let path = tool.path;
  const query: [string, string][] = [];
  const headers = new Headers({ accept: "application/json, text/plain;q=0.9, */*;q=0.5" });

  for (const p of tool.params) {
    const value = args[p.arg];
    if (value === undefined || value === null) {
      if (p.required) throw new ArgumentError(`missing required argument: ${p.arg}`);
      continue;
    }
    if (p.in === "path") {
      const encoded = Array.isArray(value)
        ? value.map((v) => encodeURIComponent(scalar(v))).join(",")
        : encodeURIComponent(scalar(value));
      path = path.split(`{${p.name}}`).join(encoded);
    } else if (p.in === "query") {
      query.push(...serializeQuery(p.name, value, p.style ?? "form", p.explode ?? true));
    } else {
      headers.set(p.name, Array.isArray(value) ? value.map(scalar).join(",") : scalar(value));
    }
  }

  const url = new URL(joinUrl(baseUrl, path));
  for (const [k, v] of query) url.searchParams.append(k, v);

  let body: string | undefined;
  if (tool.body) {
    const value = args.body;
    if (value === undefined) {
      if (tool.body.required) throw new ArgumentError("missing required argument: body");
    } else {
      headers.set("content-type", tool.body.contentType);
      body = encodeBody(value, tool.body.contentType);
    }
  }
  return { method: tool.method.toUpperCase(), url, headers, body };
}

function serializeQuery(name: string, value: unknown, style: string, explode: boolean): [string, string][] {
  if (Array.isArray(value)) {
    if (explode) return value.map((v) => [name, scalar(v)]);
    const sep = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
    return [[name, value.map(scalar).join(sep)]];
  }
  if (isObject(value as Json)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (style === "deepObject") return entries.map(([k, v]) => [`${name}[${k}]`, scalar(v)]);
    if (explode) return entries.map(([k, v]) => [k, scalar(v)]);
    return [[name, entries.flatMap(([k, v]) => [k, scalar(v)]).join(",")]];
  }
  return [[name, scalar(value)]];
}

function encodeBody(value: unknown, contentType: string): string {
  const type = contentType.toLowerCase();
  if (type === "application/x-www-form-urlencoded") {
    if (!isObject(value as Json)) throw new ArgumentError("form body must be an object");
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(v)) v.forEach((item) => form.append(k, scalar(item)));
      else if (v !== undefined && v !== null) form.append(k, scalar(v));
    }
    return form.toString();
  }
  if (type.startsWith("text/")) return typeof value === "string" ? value : JSON.stringify(value);
  return JSON.stringify(value);
}

function scalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Token bucket shared by every tool, so one chatty agent can't hammer the API. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rps: number,
    private readonly burst: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  acquire(): Promise<void> {
    if (this.rps <= 0) return Promise.resolve();
    // Chain acquisitions so waiters are served in arrival order.
    const turn = this.queue.then(() => this.take());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
      this.refill();
    }
    this.tokens -= 1;
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rps);
    this.last = t;
  }
}

export class Executor {
  private readonly limiter: RateLimiter;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secretQuery: Set<string>;
  private auditQueue: Promise<void> = Promise.resolve();

  constructor(private readonly opts: ExecutorOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = new RateLimiter(opts.rps, opts.burst, this.sleep);
    this.secretQuery = secretQueryNames(opts.auth);
  }

  async call(tool: ToolDef, args: Record<string, unknown>): Promise<CallResult> {
    const started = Date.now();
    let req: PreparedRequest;
    try {
      req = prepareRequest(tool, args, this.opts.baseUrl);
    } catch (err) {
      if (err instanceof ArgumentError) return { ok: false, text: `Invalid arguments: ${err.message}`, attempts: 0 };
      throw err;
    }
    for (const [k, v] of Object.entries(this.opts.headers ?? {})) req.headers.set(k, v);
    applyAuth(this.opts.auth, req.headers, req.url, this.opts.env);

    const result = await this.send(tool, req);
    await this.audit({
      ts: new Date(started).toISOString(),
      tool: tool.name,
      method: req.method,
      url: this.redactUrl(req.url),
      args: Object.keys(args).sort(),
      status: result.status ?? null,
      ok: result.ok,
      attempts: result.attempts,
      ms: Date.now() - started,
      ...(result.ok ? {} : { error: result.text.slice(0, 300) }),
    });
    return result;
  }

  private async send(tool: ToolDef, req: PreparedRequest): Promise<CallResult> {
    const idempotent = IDEMPOTENT.has(tool.method);
    let attempt = 0;
    for (;;) {
      attempt++;
      await this.limiter.acquire();
      let res: Response;
      try {
        res = await this.fetch(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
          redirect: "follow",
        });
      } catch (err) {
        // A failed connect never reached the server, so even a POST is safe to retry.
        const refused = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(describe(err));
        if (attempt <= this.opts.retries && (idempotent || refused)) {
          await this.sleep(backoff(attempt));
          continue;
        }
        const reason = (err as Error).name === "TimeoutError" ? `timed out after ${this.opts.timeoutMs} ms` : describe(err);
        return { ok: false, text: `Request failed: ${req.method} ${this.redactUrl(req.url)}: ${reason}`, attempts: attempt };
      }

      const retryable = res.status === 429 || (idempotent && RETRY_STATUS.has(res.status));
      if (retryable && attempt <= this.opts.retries) {
        await res.body?.cancel();
        await this.sleep(retryAfter(res.headers.get("retry-after")) ?? backoff(attempt));
        continue;
      }
      const text = await this.renderBody(res);
      if (res.ok) return { ok: true, status: res.status, text, attempts: attempt };
      return { ok: false, status: res.status, text: `HTTP ${res.status} ${res.statusText}\n${text}`.trim(), attempts: attempt };
    }
  }

  private async renderBody(res: Response): Promise<string> {
    if (res.status === 204 || res.status === 205) return `HTTP ${res.status} (no content)`;
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return `HTTP ${res.status} (empty body)`;
    let text: string;
    if (/json/i.test(type)) {
      const raw = buf.toString("utf8");
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch {
        text = raw;
      }
    } else if (/^text\/|xml|javascript|yaml|csv/i.test(type) || type === "") {
      text = buf.toString("utf8");
    } else {
      return `Binary response: ${type}, ${buf.length} bytes (not shown)`;
    }
    const max = this.opts.maxResponseChars;
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n\n[truncated: showing ${max} of ${text.length} characters. Narrow the request with filters or pagination.]`;
  }

  /** Drop values of auth and secret-looking query parameters before anything is logged. */
  redactUrl(url: URL): string {
    const copy = new URL(url);
    for (const key of [...new Set(copy.searchParams.keys())]) {
      if (this.secretQuery.has(key.toLowerCase()) || SECRET_NAME.test(key)) copy.searchParams.set(key, "REDACTED");
    }
    copy.username = "";
    copy.password = "";
    return copy.toString();
  }

  private audit(entry: Record<string, unknown>): Promise<void> {
    const path = this.opts.auditPath;
    if (!path) return Promise.resolve();
    // Serialise writes so lines never interleave under concurrent tool calls.
    this.auditQueue = this.auditQueue
      .then(() => appendFile(path, `${JSON.stringify(entry)}\n`, "utf8"))
      .catch((err) => {
        process.stderr.write(`tool-forge: audit log write failed: ${(err as Error).message}\n`);
      });
    return this.auditQueue;
  }
}

/** Exponential backoff with full jitter: 0.25 s, 0.5 s, 1 s … capped at 8 s. */
export function backoff(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(8_000, 250 * 2 ** (attempt - 1)));
}

/** Parse Retry-After (seconds or HTTP date), capped at 30 s so a tool call can't hang for minutes. */
export function retryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return undefined;
  return Math.max(0, Math.min(30_000, ms));
}

function describe(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  return e.cause?.code ?? e.cause?.message ?? e.message ?? String(err);
}
