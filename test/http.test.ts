import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAuth } from "../src/auth.js";
import { backoff, Executor, type ExecutorOptions, prepareRequest, RateLimiter, retryAfter } from "../src/http.js";
import { loadSpec } from "../src/spec.js";
import { buildTools, type ToolDef } from "../src/tools.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/petstore.yaml", import.meta.url));
const BASE = "https://api.test/v1";

async function tools(): Promise<Record<string, ToolDef>> {
  const { tools } = buildTools(await loadSpec(FIXTURE), { allowWrites: true, include: [], exclude: [] });
  return Object.fromEntries(tools.map((t) => [t.name, t]));
}

/** A fetch that replays canned responses and records every request it saw. */
function fakeFetch(responses: (Response | Error)[]) {
  const seen: { url: string; method: string; headers: Headers; body?: string }[] = [];
  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body as string | undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("fakeFetch: no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, seen };
}

function executor(f: typeof fetch, extra: Partial<ExecutorOptions> = {}) {
  const sleeps: number[] = [];
  const ex = new Executor({
    baseUrl: BASE,
    auth: [],
    rps: 0,
    burst: 1,
    retries: 3,
    timeoutMs: 1000,
    maxResponseChars: 50_000,
    fetch: f,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  });
  return { ex, sleeps };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("prepareRequest", () => {
  it("encodes path, query (form, explode, deepObject) and header params", async () => {
    const t = await tools();
    const req = prepareRequest(
      t.listPets!,
      { tag: ["a b", "c"], limit: 5, filter: { status: "sold" }, "X-Request-Id": "r1" },
      BASE,
    );
    assert.equal(req.method, "GET");
    assert.equal(
      req.url.toString(),
      "https://api.test/v1/pets?tag=a+b&tag=c&limit=5&filter%5Bstatus%5D=sold",
    );
    assert.equal(req.headers.get("x-request-id"), "r1");

    const get = prepareRequest(t.getPet!, { petId: "a/b c" }, `${BASE}/`);
    assert.equal(get.url.toString(), "https://api.test/v1/pets/a%2Fb%20c");
  });

  it("sends JSON and form bodies with the right content type", async () => {
    const t = await tools();
    const create = prepareRequest(t.createPet!, { body: { name: "Rex" } }, BASE);
    assert.equal(create.headers.get("content-type"), "application/json");
    assert.equal(create.body, '{"name":"Rex"}');

    const login = prepareRequest(t.login!, { body: { username: "u", password: "p w" } }, BASE);
    assert.equal(login.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(login.body, "username=u&password=p+w");
  });

  it("rejects missing required and unknown arguments", async () => {
    const t = await tools();
    assert.throws(() => prepareRequest(t.getPet!, {}, BASE), /missing required argument: petId/);
    assert.throws(() => prepareRequest(t.createPet!, {}, BASE), /missing required argument: body/);
    assert.throws(() => prepareRequest(t.getPet!, { petId: "1", nope: 1 }, BASE), /unknown argument\(s\): nope/);
  });
});

describe("Executor", () => {
  it("retries idempotent calls on 503 and honours Retry-After on 429", async () => {
    const t = await tools();
    const { impl, seen } = fakeFetch([
      new Response("busy", { status: 503 }),
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      json({ id: "1", name: "Rex" }),
    ]);
    const { ex, sleeps } = executor(impl);
    const res = await ex.call(t.getPet!, { petId: "1" });
    assert.equal(res.ok, true);
    assert.equal(res.attempts, 3);
    assert.equal(seen.length, 3);
    assert.equal(sleeps[1], 2000, "Retry-After seconds are respected");
    assert.match(res.text, /"name": "Rex"/);
  });

  it("does not retry a POST on 503: it may have been applied", async () => {
    const t = await tools();
    const { impl, seen } = fakeFetch([new Response("oops", { status: 503, statusText: "Service Unavailable" })]);
    const res = await executor(impl).ex.call(t.createPet!, { body: { name: "Rex" } });
    assert.equal(seen.length, 1);
    assert.equal(res.ok, false);
    assert.match(res.text, /^HTTP 503 Service Unavailable/);
  });

  it("retries a POST when the connection was refused (nothing was sent)", async () => {
    const t = await tools();
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const { impl, seen } = fakeFetch([refused, json({ id: "2" }, 201)]);
    const res = await executor(impl).ex.call(t.createPet!, { body: { name: "Rex" } });
    assert.equal(seen.length, 2);
    assert.equal(res.ok, true);
  });

  it("gives up after the retry budget and reports the last status", async () => {
    const t = await tools();
    const { impl, seen } = fakeFetch(Array.from({ length: 4 }, () => new Response("down", { status: 502 })));
    const res = await executor(impl).ex.call(t.getPet!, { petId: "1" });
    assert.equal(seen.length, 4);
    assert.equal(res.status, 502);
    assert.equal(res.ok, false);
  });

  it("injects auth from the environment and never logs it", async () => {
    const t = await tools();
    const dir = await mkdtemp(join(tmpdir(), "tf-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    const { impl, seen } = fakeFetch([json([])]);
    const { ex } = executor(impl, {
      auth: [parseAuth("bearer:TF_TOKEN"), parseAuth("query:api_key:TF_KEY")],
      env: { TF_TOKEN: "s3cret-token", TF_KEY: "s3cret-key" },
      auditPath,
    });
    await ex.call(t.listPets!, { limit: 1 });
    assert.equal(seen[0]!.headers.get("authorization"), "Bearer s3cret-token");
    assert.match(seen[0]!.url, /api_key=s3cret-key/);

    const log = await readFile(auditPath, "utf8");
    assert.doesNotMatch(log, /s3cret/);
    const entry = JSON.parse(log.trim());
    assert.equal(entry.tool, "listPets");
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.args, ["limit"]);
    assert.match(entry.url, /api_key=REDACTED/);
  });

  it("truncates huge responses and describes binary ones", async () => {
    const t = await tools();
    const big = fakeFetch([new Response("x".repeat(500), { headers: { "content-type": "text/plain" } })]);
    const res = await executor(big.impl, { maxResponseChars: 100 }).ex.call(t.getPet!, { petId: "1" });
    assert.match(res.text, /\[truncated: showing 100 of 500 characters/);

    const bin = fakeFetch([new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })]);
    const res2 = await executor(bin.impl).ex.call(t.getPet!, { petId: "1" });
    assert.equal(res2.text, "Binary response: image/png, 3 bytes (not shown)");
  });

  it("returns argument errors to the model instead of throwing", async () => {
    const t = await tools();
    const res = await executor(fakeFetch([]).impl).ex.call(t.getPet!, {});
    assert.deepEqual([res.ok, res.attempts], [false, 0]);
    assert.match(res.text, /missing required argument: petId/);
  });
});

describe("rate limiting and backoff", () => {
  it("allows a burst, then spaces calls at the configured rate", async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(2, 2, async (ms) => {
      waits.push(ms);
      now += ms;
    }, () => now);
    for (let i = 0; i < 4; i++) await limiter.acquire();
    assert.deepEqual(waits, [500, 500]);
  });

  it("caps backoff and Retry-After", () => {
    assert.equal(backoff(1, () => 1), 250);
    assert.equal(backoff(10, () => 1), 8000);
    assert.equal(retryAfter("120"), 30_000);
    assert.equal(retryAfter(new Date(10_000).toUTCString(), 5_000), 5_000);
    assert.equal(retryAfter("soon"), undefined);
  });
});
