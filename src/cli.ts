#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkAuthEnv, parseAuth } from "./auth.js";
import { DEFAULT_EXECUTOR, Executor, prepareRequest } from "./http.js";
import { DEFAULT_LIMITS, runInSandbox, type SandboxLimits } from "./sandbox.js";
import { createServer, formatResult } from "./server.js";
import { defaultServerUrl, loadSpec } from "./spec.js";
import { buildTools, type ToolDef } from "./tools.js";
import { apiNames, declareApi } from "./typegen.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const HELP = `tool-forge ${VERSION}: turn an OpenAPI spec into a code-mode MCP server

Instead of one tool per endpoint, the model gets a typed \`api\` object and writes
JavaScript against it, run in a QuickJS sandbox. Only what the script returns
comes back into the model's context.

Usage:
  tool-forge serve <spec> [options]           Run the MCP server on stdio
  tool-forge types <spec> [options]           Print the TypeScript the model sees
  tool-forge exec  <spec> <file|-> [options]  Run a script in the sandbox and print the result
  tool-forge list  <spec> [options]           List the operations that would be exposed
  tool-forge call  <spec> <operation> [json]  Call one operation directly (add --dry-run
                                              to print the HTTP request instead)

<spec> is a path or http(s) URL to an OpenAPI 3.x document (JSON or YAML).

API options:
  --base-url <url>       API base URL (default: first entry in the spec's "servers")
  --auth <spec>          bearer:ENV | header:Name:ENV | query:name:ENV | basic:USER_ENV:PASS_ENV
                         Secrets are read from environment variables. Repeatable.
  --header <Name:Value>  Static header added to every request. Repeatable.
  --allow-writes         Expose POST/PUT/PATCH/DELETE operations (read-only by default)
  --include <glob>       Only expose matching operations. Matches operationId, tool name,
                         tag or "METHOD /path". Repeatable.
  --exclude <glob>       Hide matching operations. Repeatable.
  --rps <n>              Max requests per second (default ${DEFAULT_EXECUTOR.rps}, 0 = unlimited)
  --burst <n>            Burst size for the rate limiter (default ${DEFAULT_EXECUTOR.burst})
  --retries <n>          Retries on 429, 502-504 and network errors (default ${DEFAULT_EXECUTOR.retries})
  --timeout <ms>         Per-request timeout (default ${DEFAULT_EXECUTOR.timeoutMs})
  --audit <file>         Append one JSON line per API call and per script run
                         (secrets redacted, no bodies)

Sandbox options:
  --max-calls <n>        API calls one script may make (default ${DEFAULT_LIMITS.maxCalls})
  --exec-timeout <ms>    Wall-clock limit per script (default ${DEFAULT_LIMITS.timeoutMs})
  --memory-mb <n>        Sandbox heap limit (default ${DEFAULT_LIMITS.memoryBytes / 1024 / 1024})
  --max-chars <n>        Characters of output returned to the model (default ${DEFAULT_EXECUTOR.maxResponseChars})
  --inline-types <n>     Describe the whole API in the execute tool when its TypeScript
                         fits in this many characters; above it, add search_api (default 20000)

  --name <name>          Server name reported to MCP clients (default: spec title)
  -h, --help             Show this help
  -v, --version          Show the version
`;

async function main(argv: string[]): Promise<number> {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      auth: { type: "string", multiple: true, default: [] },
      header: { type: "string", multiple: true, default: [] },
      "allow-writes": { type: "boolean", default: false },
      include: { type: "string", multiple: true, default: [] },
      exclude: { type: "string", multiple: true, default: [] },
      rps: { type: "string" },
      burst: { type: "string" },
      retries: { type: "string" },
      timeout: { type: "string" },
      "max-chars": { type: "string" },
      audit: { type: "string" },
      name: { type: "string" },
      "max-calls": { type: "string" },
      "exec-timeout": { type: "string" },
      "memory-mb": { type: "string" },
      "inline-types": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (o.version) return print(VERSION), 0;
  const [command, specPath, ...rest] = positionals;
  if (o.help || !command) return print(HELP), command || o.help ? 0 : 1;
  if (!["serve", "types", "exec", "list", "call"].includes(command)) throw new UsageError(`unknown command "${command}"`);
  if (!specPath) throw new UsageError(`${command}: missing <spec>`);

  const spec = await loadSpec(specPath);
  const { tools, skipped } = buildTools(spec, {
    allowWrites: o["allow-writes"],
    include: o.include,
    exclude: o.exclude,
  });

  if (command === "list") {
    printList(tools, skipped);
    return 0;
  }
  if (command === "types") {
    print(declareApi(apiNames(tools)));
    return 0;
  }

  const baseUrl = o["base-url"] ?? defaultServerUrl(spec);
  if (!baseUrl) throw new UsageError("the spec has no absolute server URL; pass --base-url");
  if (/\{[^}]+\}/.test(baseUrl)) throw new UsageError(`server URL has unfilled variables (${baseUrl}); pass --base-url`);
  const auth = o.auth.map(parseAuth);
  const executor = new Executor({
    baseUrl,
    auth,
    headers: Object.fromEntries(o.header.map(parseHeader)),
    rps: num(o.rps, DEFAULT_EXECUTOR.rps, "--rps"),
    burst: num(o.burst, DEFAULT_EXECUTOR.burst, "--burst"),
    retries: num(o.retries, DEFAULT_EXECUTOR.retries, "--retries"),
    timeoutMs: num(o.timeout, DEFAULT_EXECUTOR.timeoutMs, "--timeout"),
    maxResponseChars: num(o["max-chars"], DEFAULT_EXECUTOR.maxResponseChars, "--max-chars"),
    auditPath: o.audit,
  });

  if (command === "call") {
    const [toolName, json] = rest;
    if (!toolName) throw new UsageError("call: missing <tool>");
    const tool = tools.find((t) => t.name === toolName) ?? tools.find((t) => t.operationId === toolName) ??
      apiNames(tools).get(toolName.replace(/^api\./, ""));
    if (!tool) {
      const why = skipped.find((s) => s.operationId === toolName);
      throw new UsageError(`no tool named "${toolName}"${why ? `: ${why.reason}` : ""}. Run "tool-forge list" to see them.`);
    }
    const args = json ? (JSON.parse(json) as Record<string, unknown>) : {};
    if (o["dry-run"]) {
      const req = prepareRequest(tool, args, baseUrl);
      print(`${req.method} ${req.url}`);
      req.headers.forEach((v, k) => print(`${k}: ${v}`));
      if (req.body) print(`\n${req.body}`);
      return 0;
    }
    checkAuthEnv(auth);
    const result = await executor.call(tool, args);
    print(result.text);
    return result.ok ? 0 : 2;
  }

  const limits: SandboxLimits = {
    maxCalls: num(o["max-calls"], DEFAULT_LIMITS.maxCalls, "--max-calls"),
    timeoutMs: num(o["exec-timeout"], DEFAULT_LIMITS.timeoutMs, "--exec-timeout"),
    memoryBytes: num(o["memory-mb"], DEFAULT_LIMITS.memoryBytes / 1024 / 1024, "--memory-mb") * 1024 * 1024,
  };
  const maxChars = num(o["max-chars"], DEFAULT_EXECUTOR.maxResponseChars, "--max-chars");

  if (command === "exec") {
    const [file] = rest;
    if (!file) throw new UsageError("exec: missing <file> (use - to read the script from stdin)");
    const code = file === "-" ? await readStdin() : await readFile(file, "utf8");
    checkAuthEnv(auth);
    const result = await runInSandbox(code, apiNames(tools), executor, limits);
    await executor.auditExecution({
      ms: result.ms,
      calls: result.calls,
      ok: result.ok,
      codeChars: code.length,
      ...(result.ok ? {} : { error: result.error?.slice(0, 300) }),
    });
    print(formatResult(result, maxChars));
    return result.ok ? 0 : 2;
  }

  checkAuthEnv(auth);
  if (tools.length === 0) process.stderr.write("tool-forge: warning: no operations exposed (check --include/--allow-writes)\n");
  const info = spec.doc.info as { title?: unknown } | undefined;
  const name = o.name ?? (typeof info?.title === "string" ? info.title : "tool-forge");
  const server = createServer(tools, executor, {
    name,
    version: VERSION,
    limits,
    maxResponseChars: maxChars,
    inlineTypesUpTo: num(o["inline-types"], 20_000, "--inline-types"),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`tool-forge: code mode for ${tools.length} operation(s) at ${baseUrl}\n`);
  return new Promise<number>(() => {}); // run until the client disconnects
}

function printList(tools: ToolDef[], skipped: { method: string; path: string; reason: string }[]): void {
  const names = [...apiNames(tools)];
  const width = Math.max(4, ...names.map(([n]) => n.length + 4));
  print(`${tools.length} operation(s):`);
  for (const [n, t] of names) {
    const mode = t.annotations.readOnlyHint ? "read " : t.annotations.destructiveHint ? "DEL  " : "write";
    print(`  ${`api.${n}`.padEnd(width)}  ${mode}  ${t.method.toUpperCase().padEnd(6)} ${t.path}`);
  }
  if (skipped.length) {
    print(`\n${skipped.length} skipped:`);
    for (const s of skipped) print(`  ${s.method.toUpperCase().padEnd(6)} ${s.path}: ${s.reason}`);
  }
}

function parseHeader(h: string): [string, string] {
  const i = h.indexOf(":");
  if (i <= 0) throw new UsageError(`invalid --header "${h}"; expected Name:Value`);
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}

function num(raw: string | undefined, fallback: number, flag: string): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number`);
  return n;
}

class UsageError extends Error {}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function print(s: string): void {
  process.stdout.write(`${s}\n`);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    process.stderr.write(`tool-forge: ${err.message}\n${err instanceof UsageError ? "Run tool-forge --help for usage.\n" : ""}`);
    process.exit(1);
  },
);
