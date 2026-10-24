import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Executor, InvokeResult } from "../src/http.js";
import { runInSandbox, type SandboxLimits } from "../src/sandbox.js";
import type { ToolDef } from "../src/tools.js";

const LIMITS: SandboxLimits = { timeoutMs: 5_000, memoryBytes: 16 * 1024 * 1024, maxCalls: 10 };
const op = (name: string) => ({ name, method: "get" }) as ToolDef;

/** An executor stand-in that records calls and answers from a function. */
function fakeExecutor(answer: (name: string, args: Record<string, unknown>) => InvokeResult | Promise<InvokeResult>) {
  const seen: { name: string; args: Record<string, unknown> }[] = [];
  const executor = {
    invoke: async (tool: ToolDef, args: Record<string, unknown>) => {
      seen.push({ name: tool.name, args });
      return answer(tool.name, args);
    },
  } as unknown as Executor;
  return { executor, seen };
}

const ok = (body: unknown): InvokeResult => ({ ok: true, status: 200, body, attempts: 1 });
const run = (code: string, answer = (_n: string, a: Record<string, unknown>) => ok(a), limits = LIMITS) => {
  const { executor, seen } = fakeExecutor(answer);
  const ops = new Map([["echo", op("echo")], ["slow", op("slow")]]);
  return runInSandbox(code, ops, executor, limits).then((r) => ({ ...r, seen }));
};

describe("sandbox isolation", () => {
  it("has no network, module, process or timer access", async () => {
    const r = await run(`return [typeof fetch, typeof require, typeof process, typeof setTimeout,
      typeof XMLHttpRequest, typeof WebSocket, typeof Deno, typeof __call, typeof __log];`);
    assert.deepEqual(r.value, Array(9).fill("undefined"));
  });

  it("cannot replace api operations or reach the host through them", async () => {
    const r = await run(`
      api.echo = () => "hijacked";
      const desc = Object.getOwnPropertyDescriptor(api, "echo");
      return [Object.isFrozen(api), desc.writable, typeof api.echo.constructor("return this")().process];
    `);
    assert.deepEqual(r.value, [true, false, "undefined"]);
  });

  it("stops runaway CPU and memory", async () => {
    const cpu = await run("while (true) {}", undefined, { ...LIMITS, timeoutMs: 300 });
    assert.equal(cpu.ok, false);
    assert.match(cpu.error!, /CPU time limit reached/);

    const mem = await run("const a = []; for (;;) a.push(new Array(1e5).fill(1));");
    assert.equal(mem.ok, false);
    assert.match(mem.error!, /memory limit reached|CPU time limit reached/);
  });

  it("times out while waiting on a call that never returns, without leaking", async () => {
    const r = await run("return await api.slow();", () => new Promise(() => {}), { ...LIMITS, timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.match(r.error!, /timed out after 200 ms \(still waiting on 1 API call\(s\)\)/);
  });
});

describe("sandbox api bridge", () => {
  it("passes arguments through and returns parsed bodies", async () => {
    const r = await run(`return await api.echo({ n: 1, tags: ["a"] });`);
    assert.deepEqual(r.value, { n: 1, tags: ["a"] });
    assert.deepEqual(r.seen, [{ name: "echo", args: { n: 1, tags: ["a"] } }]);
  });

  it("runs independent calls concurrently", async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await run("return (await Promise.all([1, 2, 3, 4].map((i) => api.slow({ i })))).length;", async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((res) => setTimeout(res, 30));
      inFlight--;
      return ok(null);
    });
    assert.equal(r.value, 4);
    assert.equal(peak, 4);
  });

  it("turns failures into ApiError with status and body", async () => {
    const r = await run(
      "try { await api.echo(); } catch (e) { return [e instanceof ApiError, e.name, e.status, e.body, e.message]; }",
      () => ({ ok: false, status: 422, statusText: "Unprocessable Entity", body: { field: "name" }, attempts: 1 }),
    );
    assert.deepEqual(r.value, [true, "ApiError", 422, { field: "name" }, "HTTP 422 Unprocessable Entity"]);
  });

  it("counts calls and refuses the ones over budget", async () => {
    const r = await run("for (let i = 0; i < 12; i++) await api.echo({ i });");
    assert.equal(r.ok, false);
    assert.equal(r.calls, 10);
    assert.equal(r.seen.length, 10, "the 11th call never reached the executor");
  });
});

describe("sandbox output", () => {
  it("captures console output with levels, and caps it", async () => {
    const r = await run(`
      console.log("hello", { a: 1 });
      console.warn("careful");
      for (let i = 0; i < 300; i++) console.log(i);
    `);
    assert.equal(r.logs[0], 'hello {"a":1}');
    assert.equal(r.logs[1], "[warn] careful");
    assert.equal(r.logs.length, 201);
    assert.match(r.logs.at(-1)!, /truncated after 200 lines/);
  });

  it("reports errors at the line the script author wrote", async () => {
    const r = await run("const a = 1;\nconst b = 2;\nnull.boom;");
    assert.equal(r.ok, false);
    assert.match(r.error!, /^TypeError: cannot read property 'boom' of null/);
    assert.match(r.error!, /line 3/);
    assert.doesNotMatch(r.error!, /prelude/);
  });

  it("reports syntax errors without running anything", async () => {
    const r = await run("return (;");
    assert.equal(r.ok, false);
    assert.match(r.error!, /^SyntaxError/);
    assert.equal(r.calls, 0);
  });

  it("allows scripts with no return value", async () => {
    const r = await run("await api.echo();");
    assert.deepEqual([r.ok, r.value], [true, undefined]);
  });
});
