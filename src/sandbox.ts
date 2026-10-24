import * as releaseSync from "@jitl/quickjs-wasmfile-release-sync";
import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";
import type { Executor } from "./http.js";
import type { ToolDef } from "./tools.js";

/**
 * Runs model-written JavaScript in a QuickJS WebAssembly sandbox. The only way
 * out is `api.<operation>(args)`, which calls back into the host executor, so
 * auth, rate limits, retries, read-only policy and the audit log all apply and
 * credentials never enter the sandbox. There is no fetch, no filesystem, no
 * process, no timers: just the language, `api`, and `console`.
 */

export interface SandboxLimits {
  /** Wall-clock limit for the whole execution, including time spent waiting on the API. */
  timeoutMs: number;
  /** QuickJS heap limit. */
  memoryBytes: number;
  /** Most API calls one execution may make. */
  maxCalls: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 60_000, memoryBytes: 64 * 1024 * 1024, maxCalls: 50 };

export interface ExecResult {
  ok: boolean;
  /** The script's return value (JSON-compatible), when it succeeded. */
  value?: unknown;
  /** Why it failed: an uncaught exception, a limit, or a syntax error. */
  error?: string;
  logs: string[];
  calls: number;
  ms: number;
}

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 2_000;

let modulePromise: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => (modulePromise ??= newQuickJSWASMModuleFromVariant(releaseSync as never));

// Runs inside the sandbox before the user's code. `__call` and `__log` are
// host functions; everything the script sees is built from them here.
const PRELUDE = `
class ApiError extends Error {
  constructor(message, status, body) { super(message); this.name = "ApiError"; this.status = status; this.body = body; }
}
globalThis.ApiError = ApiError;
const call = globalThis.__call, log = globalThis.__log;
delete globalThis.__call; delete globalThis.__log;
globalThis.api = Object.freeze(Object.fromEntries(JSON.parse(globalThis.__names).map((name) => [name,
  async (args) => {
    const r = JSON.parse(await call(name, JSON.stringify(args === undefined ? {} : args)));
    if (!r.ok) throw new ApiError(r.error, r.status, r.body);
    return r.body;
  }])));
delete globalThis.__names;
const fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
globalThis.console = Object.freeze(Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) =>
  [level, (...args) => log(level, args.map(fmt).join(" "))])));
`;

/** Execute `code` (the body of an async function) with `api` bound to `operations`. */
export async function runInSandbox(
  code: string,
  operations: Map<string, ToolDef>,
  executor: Executor,
  limits: SandboxLimits = DEFAULT_LIMITS,
): Promise<ExecResult> {
  const started = Date.now();
  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(started + limits.timeoutMs));
  const ctx = runtime.newContext();

  const logs: string[] = [];
  const pending = new Set<QuickJSDeferredPromise>();
  let calls = 0;
  let finished = false;

  const settle = (deferred: QuickJSDeferredPromise, envelope: unknown) => {
    pending.delete(deferred);
    if (finished) return; // the execution already ended; the context is gone
    const handle = ctx.newString(JSON.stringify(envelope));
    deferred.resolve(handle);
    handle.dispose();
    runtime.executePendingJobs();
  };

  defineFunction(ctx, "__call", (nameH, argsH) => {
    const name = ctx.getString(nameH);
    const deferred = ctx.newPromise();
    pending.add(deferred);
    const tool = operations.get(name);
    if (!tool) {
      queueMicrotask(() => settle(deferred, { ok: false, error: `api.${name} does not exist` }));
    } else if (++calls > limits.maxCalls) {
      queueMicrotask(() =>
        settle(deferred, { ok: false, error: `call limit reached (${limits.maxCalls} API calls per execution)` }));
    } else {
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(ctx.getString(argsH));
      } catch {
        args = {};
      }
      executor.invoke(tool, args).then(
        (r) => settle(deferred, r.ok
          ? { ok: true, body: r.body ?? null }
          : { ok: false, status: r.status, body: r.body ?? null, error: r.error ?? `HTTP ${r.status} ${r.statusText ?? ""}`.trim() }),
        (e: Error) => settle(deferred, { ok: false, error: e.message }),
      );
    }
    return deferred.handle;
  });
  defineFunction(ctx, "__log", (levelH, textH) => {
    if (logs.length < MAX_LOG_LINES) {
      const level = ctx.getString(levelH);
      const text = ctx.getString(textH).slice(0, MAX_LOG_LINE);
      logs.push(level === "log" || level === "info" ? text : `[${level}] ${text}`);
    } else if (logs.length === MAX_LOG_LINES) {
      logs.push(`[console output truncated after ${MAX_LOG_LINES} lines]`);
    }
    return ctx.undefined;
  });
  const names = ctx.newString(JSON.stringify([...operations.keys()]));
  ctx.setProp(ctx.global, "__names", names);
  names.dispose();

  const done = (r: Omit<ExecResult, "logs" | "calls" | "ms">): ExecResult => ({
    ...r,
    logs,
    calls: Math.min(calls, limits.maxCalls),
    ms: Date.now() - started,
  });

  try {
    const prelude = ctx.evalCode(PRELUDE, "prelude.js");
    if (prelude.error) throw new Error(`sandbox setup failed: ${describe(ctx, prelude.error)}`);
    prelude.value.dispose();

    const evaluated = ctx.evalCode(`(async () => {\n${code}\n})()`, "script.js");
    if (evaluated.error) return done({ ok: false, error: describe(ctx, evaluated.error) });
    const outcome = ctx.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    runtime.executePendingJobs();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => {
      timer = setTimeout(() => r("timeout"), Math.max(0, started + limits.timeoutMs - Date.now()));
    });
    const settled = await Promise.race([outcome, timeout]);
    clearTimeout(timer);
    if (settled === "timeout") {
      outcome.then((r) => (r.error ?? r.value)?.dispose(), () => {});
      return done({ ok: false, error: `timed out after ${limits.timeoutMs} ms (still waiting on ${pending.size} API call(s))` });
    }
    if (settled.error) return done({ ok: false, error: describe(ctx, settled.error) });
    const value = ctx.dump(settled.value);
    settled.value.dispose();
    return done({ ok: true, value });
  } catch (e) {
    return done({ ok: false, error: (e as Error).message });
  } finally {
    finished = true;
    for (const d of pending) d.dispose();
    pending.clear();
    ctx.dispose();
    runtime.dispose();
  }
}

function defineFunction(
  ctx: QuickJSContext,
  name: string,
  fn: (...args: QuickJSHandle[]) => QuickJSHandle,
): void {
  const handle = ctx.newFunction(name, fn);
  ctx.setProp(ctx.global, name, handle);
  handle.dispose();
}

/** Turn a thrown sandbox value into one readable line (stack included for real errors). */
function describe(ctx: QuickJSContext, errorHandle: QuickJSHandle): string {
  const err = ctx.dump(errorHandle) as { name?: string; message?: string; stack?: string; status?: number; body?: unknown } | unknown;
  errorHandle.dispose();
  if (typeof err !== "object" || err === null) return `Uncaught ${JSON.stringify(err)}`;
  const e = err as { name?: string; message?: string; stack?: string; status?: number; body?: unknown };
  if (e.name === "InternalError" && e.message === "interrupted") return "execution interrupted: CPU time limit reached";
  if (e.name === "InternalError" && /out of memory/i.test(e.message ?? "")) return "execution stopped: memory limit reached";
  const head = `${e.name ?? "Error"}: ${e.message ?? ""}`;
  const body = e.body !== undefined && e.body !== null
    ? `\nResponse body: ${(typeof e.body === "string" ? e.body : JSON.stringify(e.body)).slice(0, 1_000)}`
    : "";
  // Show only frames in the user's script, with line numbers matching what they
  // wrote (the script is wrapped in one extra line).
  const frames = (e.stack ?? "")
    .split("\n")
    .filter((l) => l.includes("script.js"))
    .map((l) => l.replace(/script\.js:(\d+)/, (_m, n: string) => `line ${Math.max(1, Number(n) - 1)}`));
  const stack = frames.length ? `\n${frames.join("\n")}` : "";
  return `${head}${body}${stack}`;
}
