#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkAuthEnv, parseAuth } from "./auth.js";
import { DEFAULT_EXECUTOR, Executor, prepareRequest } from "./http.js";
import { createServer } from "./server.js";
import { defaultServerUrl, loadSpec } from "./spec.js";
import { buildTools, type ToolDef } from "./tools.js";

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string })
  .version;

const DISCOVER_THRESHOLD = 40;

const HELP = `tool-forge ${VERSION}: turn an OpenAPI spec into an MCP server

Usage:
  tool-forge serve <spec> [options]           Run an MCP server on stdio
  tool-forge list  <spec> [options]           Show the tools that would be exposed
  tool-forge call  <spec> <tool> [json-args]  Call one tool and print the result
                   [--dry-run]                ...or just print the HTTP request

<spec> is a path or http(s) URL to an OpenAPI 3.x document (JSON or YAML).

Options:
  --base-url <url>       API base URL (default: first entry in the spec's "servers")
  --auth <spec>          bearer:ENV | header:Name:ENV | query:name:ENV | basic:USER_ENV:PASS_ENV
                         Secrets are read from environment variables. Repeatable.
  --header <Name:Value>  Static header added to every request. Repeatable.
  --allow-writes         Expose POST/PUT/PATCH/DELETE operations (read-only by default)
  --include <glob>       Only expose matching operations. Matches operationId, tool name,
                         tag or "METHOD /path". Repeatable.
  --exclude <glob>       Hide matching operations. Repeatable.
  --rps <n>              Max requests per second across all tools (default ${DEFAULT_EXECUTOR.rps}, 0 = unlimited)
  --burst <n>            Burst size for the rate limiter (default ${DEFAULT_EXECUTOR.burst})
  --retries <n>          Retries on 429, 502-504 and network errors (default ${DEFAULT_EXECUTOR.retries})
  --timeout <ms>         Per-attempt timeout (default ${DEFAULT_EXECUTOR.timeoutMs})
  --max-chars <n>        Truncate responses longer than this (default ${DEFAULT_EXECUTOR.maxResponseChars})
  --audit <file>         Append one JSON line per call (secrets redacted, no bodies)
  --name <name>          Server name reported to MCP clients (default: spec title)
  --discover <mode>      auto | on | off. "on" exposes two tools, find_operations and
                         call_operation, instead of one tool per operation. "auto"
                         (default) turns it on above ${DISCOVER_THRESHOLD} tools.
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
      discover: { type: "string", default: "auto" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  if (o.version) return print(VERSION), 0;
  const [command, specPath, ...rest] = positionals;
  if (o.help || !command) return print(HELP), command || o.help ? 0 : 1;
  if (!["serve", "list", "call"].includes(command)) throw new UsageError(`unknown command "${command}"`);
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
    const tool = tools.find((t) => t.name === toolName) ?? tools.find((t) => t.operationId === toolName);
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

  checkAuthEnv(auth);
  if (tools.length === 0) process.stderr.write("tool-forge: warning: no tools exposed (check --include/--allow-writes)\n");
  const info = spec.doc.info as { title?: unknown } | undefined;
  const name = o.name ?? (typeof info?.title === "string" ? info.title : "tool-forge");
  if (!["auto", "on", "off"].includes(o.discover)) throw new UsageError("--discover must be auto, on or off");
  const discover = o.discover === "on" || (o.discover === "auto" && tools.length > DISCOVER_THRESHOLD);
  const server = createServer(tools, executor, {
    name,
    version: VERSION,
    discover,
    maxResponseChars: num(o["max-chars"], DEFAULT_EXECUTOR.maxResponseChars, "--max-chars"),
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `tool-forge: serving ${tools.length} operation(s) for ${baseUrl}${discover ? " via find_operations/call_operation" : ""}\n`,
  );
  return new Promise<number>(() => {}); // run until the client disconnects
}

function printList(tools: ToolDef[], skipped: { method: string; path: string; reason: string }[]): void {
  const width = Math.max(4, ...tools.map((t) => t.name.length));
  print(`${tools.length} tool(s):`);
  for (const t of tools) {
    const mode = t.annotations.readOnlyHint ? "read " : t.annotations.destructiveHint ? "DEL  " : "write";
    print(`  ${t.name.padEnd(width)}  ${mode}  ${t.method.toUpperCase().padEnd(6)} ${t.path}`);
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
