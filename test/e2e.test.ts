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

describe("tool-forge over stdio", () => {
  const api = petApi();
  let baseUrl: string;
  before(async () => {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1`;
  });
  after(() => api.server.close());

  it("serves read-only tools by default and calls the real API", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), ["getPet", "get_search", "listPets"]);
      assert.equal(tools.find((t) => t.name === "getPet")!.annotations?.readOnlyHint, true);

      const res = await client.callTool({ name: "getPet", arguments: { petId: "1" } });
      assert.equal(res.isError, false);
      assert.match((res.content as { text: string }[])[0]!.text, /"name": "Rex"/);
      assert.equal(api.requests.at(-1)!.auth, "Bearer e2e-token");

      const missing = await client.callTool({ name: "getPet", arguments: { petId: "999" } });
      assert.equal(missing.isError, true);
      assert.match((missing.content as { text: string }[])[0]!.text, /HTTP 404[\s\S]*no such pet/);
    } finally {
      await client.close();
    }
  });

  it("retries through a transient 503", async () => {
    const client = await connect(baseUrl, ["--rps", "0"]);
    try {
      api.failOnce();
      const before = api.requests.length;
      const res = await client.callTool({ name: "listPets", arguments: { limit: 1 } });
      assert.equal(res.isError, false);
      assert.equal(api.requests.length - before, 2);
    } finally {
      await client.close();
    }
  });

  it("creates and deletes only with --allow-writes", async () => {
    const client = await connect(baseUrl, ["--rps", "0", "--allow-writes", "--include", "pets"]);
    try {
      const { tools } = await client.listTools();
      assert.equal(tools.find((t) => t.name === "deletePet")!.annotations?.destructiveHint, true);

      const created = await client.callTool({ name: "createPet", arguments: { body: { name: "Mochi" } } });
      assert.equal(created.isError, false);
      const id = JSON.parse((created.content as { text: string }[])[0]!.text).id as string;
      assert.equal(api.pets.get(id)?.name, "Mochi");

      const deleted = await client.callTool({ name: "deletePet", arguments: { petId: id } });
      assert.equal(deleted.isError, false);
      assert.equal(api.pets.has(id), false);
    } finally {
      await client.close();
    }
  });
});

describe("discovery mode", () => {
  const api = petApi();
  let baseUrl: string;
  before(async () => {
    api.server.listen(0, "127.0.0.1");
    await once(api.server, "listening");
    baseUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}/v1`;
  });
  after(() => api.server.close());

  it("exposes find_operations + call_operation and routes through them", async () => {
    const client = await connect(baseUrl, ["--rps", "0", "--discover", "on"]);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ["find_operations", "call_operation"]);
      assert.equal(tools[1]!.annotations?.readOnlyHint, true, "read-only server => read-only call_operation");

      const found = await client.callTool({ name: "find_operations", arguments: { query: "get a pet by id" } });
      const matches = JSON.parse((found.content as { text: string }[])[0]!.text) as { name: string; inputSchema: object }[];
      assert.equal(matches[0]!.name, "getPet");
      assert.ok(matches[0]!.inputSchema, "schemas come back with the matches");

      const called = await client.callTool({ name: "call_operation", arguments: { name: "getPet", arguments: { petId: "1" } } });
      assert.equal(called.isError, false);
      assert.match((called.content as { text: string }[])[0]!.text, /Rex/);

      const bad = await client.callTool({ name: "call_operation", arguments: { name: "nope" } });
      assert.equal(bad.isError, true);
      assert.match((bad.content as { text: string }[])[0]!.text, /Use find_operations/);
    } finally {
      await client.close();
    }
  });
});
