import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/petstore.yaml", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** A tiny in-memory pet API that matches the fixture spec. */
function petApi() {
  const pets = new Map([["1", { id: "1", name: "Rex" }]]);
  const requests: { method: string; url: string; auth?: string }[] = [];
  let failNext = 0;
  const server = createHttpServer(async (req: IncomingMessage, res) => {
    requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
    if (req.headers.authorization !== "Bearer e2e-token") return send(res, 401, { error: "unauthorized" });
    if (failNext > 0) {
      failNext--;
      return send(res, 503, { error: "warming up" });
    }
    const url = new URL(req.url!, "http://x");
    const m = url.pathname.match(/^\/v1\/pets(?:\/([^/]+))?$/);
    if (!m) return send(res, 404, { error: "not found" });
    const id = m[1] && decodeURIComponent(m[1]);
    if (req.method === "GET" && !id) {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      return send(res, 200, [...pets.values()].slice(0, limit));
    }
    if (req.method === "GET" && id) return pets.has(id) ? send(res, 200, pets.get(id)) : send(res, 404, { error: "no such pet" });
    if (req.method === "POST" && !id) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const pet = { id: String(pets.size + 1), ...JSON.parse(raw) };
      pets.set(pet.id, pet);
      return send(res, 201, pet);
    }
    if (req.method === "DELETE" && id) return pets.delete(id) ? send(res, 204) : send(res, 404, { error: "no such pet" });
    send(res, 405, { error: "method not allowed" });
  });
  return { server, pets, requests, failOnce: () => void (failNext = 1) };
}

function send(res: import("node:http").ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function connect(baseUrl: string, extra: string[]) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", CLI, "serve", FIXTURE, "--base-url", baseUrl, "--auth", "bearer:E2E_TOKEN", ...extra],
    env: { ...(process.env as Record<string, string>), E2E_TOKEN: "e2e-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]!.text);
const exec = (client: Client, code: string) => client.callTool({ name: "execute", arguments: { code } });

describe("code mode over stdio", () => {
  const api = petApi();
  let baseUrl: string;
  before(async () => {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1`;
  });
  after(() => api.server.close());

  it("exposes one execute tool that documents the typed api", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["execute"]);
      const description = tools[0]!.description!;
      assert.match(description, /getPet\(args: \{\n\s+petId: string;\n\s+\}\): Promise<\{/);
      assert.doesNotMatch(description, /deletePet/, "write operations are not in the api by default");
      assert.equal(tools[0]!.annotations?.readOnlyHint, true);
    } finally {
      await client.close();
    }
  });

  it("runs a script that chains calls, filters, and returns only the answer", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      const res = await exec(client, `
        const pets = await api.listPets({ limit: 10 });
        const full = await Promise.all(pets.map((p) => api.getPet({ petId: p.id })));
        console.log("checked", full.length);
        return full.map((p) => p.name);
      `);
      assert.equal(res.isError, false);
      const out = textOf(res);
      assert.match(out, /^\[\n  "Rex"\n\]/);
      assert.match(out, /--- console ---\nchecked 1/);
      assert.match(out, /--- 2 API calls · \d+ ms ---$/);
      assert.equal(api.requests.at(-1)!.auth, "Bearer e2e-token", "auth is added on the host side");
    } finally {
      await client.close();
    }
  });

  it("surfaces API errors as ApiError the script can catch", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      const caught = await exec(client, `
        try { await api.getPet({ petId: "999" }); } catch (e) { return [e.name, e.status, e.body.error]; }
      `);
      assert.match(textOf(caught), /"ApiError",\s+404,\s+"no such pet"/);

      const uncaught = await exec(client, `const p = await api.getPet({ petId: "999" });\nreturn p;`);
      assert.equal(uncaught.isError, true);
      assert.match(textOf(uncaught), /^Error: ApiError: HTTP 404 Not Found\nResponse body: \{"error":"no such pet"\}/);
    } finally {
      await client.close();
    }
  });

  it("retries through a transient 503 inside a script", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      api.failOnce();
      const before = api.requests.length;
      const res = await exec(client, "return (await api.listPets()).length;");
      assert.equal(textOf(res).split("\n")[0], "1");
      assert.equal(api.requests.length - before, 2);
    } finally {
      await client.close();
    }
  });

  it("only puts write operations in the api with --allow-writes", async () => {
    const client = await connect(baseUrl, ["--rps", "0", "--allow-writes", "--include", "pets"]);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools[0]!.annotations?.destructiveHint, true);
      const res = await exec(client, `
        const pet = await api.createPet({ body: { name: "Mochi" } });
        await api.deletePet({ petId: pet.id });
        return pet.name;
      `);
      assert.equal(textOf(res).split("\n")[0], '"Mochi"');
      assert.ok(![...api.pets.values()].some((p) => p.name === "Mochi"));
    } finally {
      await client.close();
    }
  });

  it("enforces the call budget and the time limit", async () => {
    const client = await connect(baseUrl, ["--rps", "0", "--max-calls", "3", "--exec-timeout", "1000"]);
    try {
      const budget = await exec(client, "for (let i = 0; i < 5; i++) await api.listPets();");
      assert.equal(budget.isError, true);
      assert.match(textOf(budget), /call limit reached \(3 API calls per execution\)/);

      const spin = await exec(client, "while (true) {}");
      assert.equal(spin.isError, true);
      assert.match(textOf(spin), /CPU time limit reached/);
    } finally {
      await client.close();
    }
  });
});

describe("code mode for large APIs", () => {
  const api = petApi();
  let baseUrl: string;
  before(async () => {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1`;
  });
  after(() => api.server.close());

  it("adds search_api and leaves the declarations out of execute", async () => {
    const client = await connect(baseUrl, ["--rps", "0", "--inline-types", "100"]);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["execute", "search_api"]);
      assert.doesNotMatch(tools[0]!.description!, /getPet\(/);
      assert.match(tools[0]!.description!, /Use search_api/);

      const found = await client.callTool({ name: "search_api", arguments: { query: "get a pet by id", limit: 1 } });
      assert.match(textOf(found), /^declare const api: \{[\s\S]*getPet\(args: \{/);
      const res = await exec(client, 'return (await api.getPet({ petId: "1" })).name;');
      assert.equal(textOf(res).split("\n")[0], '"Rex"');
    } finally {
      await client.close();
    }
  });
});
