import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { searchTools } from "./discover.js";
import type { Executor } from "./http.js";
import { DEFAULT_LIMITS, type ExecResult, runInSandbox, type SandboxLimits } from "./sandbox.js";
import type { ToolDef } from "./tools.js";
import { apiNames, declareApi } from "./typegen.js";

export interface ServerOptions {
  name: string;
  version: string;
  limits?: SandboxLimits;
  /** Characters of result text returned to the model. */
  maxResponseChars?: number;
  /**
   * APIs whose TypeScript declarations fit in this many characters are
   * described in full in the `execute` tool; larger ones get `search_api`.
   */
  inlineTypesUpTo?: number;
}

export const EXECUTE_TOOL = "execute";
export const SEARCH_TOOL = "search_api";
const DEFAULT_INLINE = 20_000;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

/**
 * A code-mode MCP server. Instead of one tool per endpoint, the model gets a
 * typed `api` object and writes a short script against it. Chained calls,
 * loops and filtering happen in the sandbox, so only the final answer comes
 * back into the model's context.
 */
export function createServer(tools: ToolDef[], executor: Executor, opts: ServerOptions): Server {
  const operations = apiNames(tools);
  const apiNameOf = new Map([...operations].map(([n, t]) => [t.name, n]));
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const declarations = declareApi(operations);
  const inline = declarations.length <= (opts.inlineTypesUpTo ?? DEFAULT_INLINE);
  const server = new Server({ name: opts.name, version: opts.version }, { capabilities: { tools: {} } });

  const listed = [
    {
      name: EXECUTE_TOOL,
      description: executeDescription(opts.name, operations, limits, inline ? declarations : undefined),
      inputSchema: {
        type: "object" as const,
        properties: {
          code: {
            type: "string",
            description: "Body of an async JavaScript function. Use `await api.<operation>(args)` and `return` the result.",
          },
        },
        required: ["code"],
        additionalProperties: false,
      },
      annotations: {
        title: `Run code against the ${opts.name} API`,
        readOnlyHint: tools.every((t) => t.annotations.readOnlyHint),
        destructiveHint: tools.some((t) => t.annotations.destructiveHint),
        openWorldHint: true,
      },
    },
    ...(inline ? [] : [{
      name: SEARCH_TOOL,
      description: `Find ${opts.name} API operations by what you want to do. Returns their TypeScript declarations ` +
        `(arguments, return types, docs) so you can call them from ${EXECUTE_TOOL}. ` +
        `Search before writing code: the API has ${operations.size} operations.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: 'What you want to do, e.g. "list open pull requests"' },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 6 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { title: "Search API operations", readOnlyHint: true, openWorldHint: false },
    }]),
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const max = opts.maxResponseChars ?? 50_000;

    if (name === SEARCH_TOOL && !inline) {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 6));
      const found = searchTools(tools, query, limit).map((m) => apiNameOf.get(m.name)!);
      if (found.length === 0) return text(`No operations match "${query}". Try other words.`);
      return text(truncate(declareApi(operations, found), max, "ask for fewer results with `limit`"));
    }

    if (name === EXECUTE_TOOL) {
      if (typeof args.code !== "string" || !args.code.trim()) return text("`code` must be a non-empty string", true);
      const result = await runInSandbox(args.code, operations, executor, limits);
      await executor.auditExecution({
        ms: result.ms,
        calls: result.calls,
        ok: result.ok,
        codeChars: args.code.length,
        ...(result.ok ? {} : { error: result.error?.slice(0, 300) }),
      });
      return text(formatResult(result, max), !result.ok);
    }

    return text(`Unknown tool: ${name}`, true);
  });

  return server;
}

function executeDescription(
  apiName: string,
  operations: Map<string, ToolDef>,
  limits: SandboxLimits,
  declarations: string | undefined,
): string {
  const lines = [
    `Run JavaScript against the ${apiName} API and get back what it returns.`,
    "",
    "Write the body of an async function. Call operations with `await api.<operation>(args)`, combine and filter the " +
    "results in code, and `return` only what you need: intermediate data stays out of your context. Independent calls " +
    "can run together with `Promise.all`. A failed call throws `ApiError` with `.status` and `.body`. `console.log` " +
    "output is returned too.",
    "",
    "The sandbox has only `api`, `console` and standard JavaScript: no fetch, require, filesystem or timers. " +
    `Each run may make ${limits.maxCalls} API calls and take ${Math.round(limits.timeoutMs / 1000)} s.`,
    "",
  ];
  if (declarations) {
    lines.push("Available operations:", "", "```ts", declarations, "```");
  } else {
    lines.push(
      `The API has ${operations.size} operations, too many to list here. Use ${SEARCH_TOOL} to find the ones you need ` +
        "and read their declarations before calling them.",
    );
  }
  return lines.join("\n");
}

/** What the model sees after a run: the return value, console output, and a footer. */
export function formatResult(r: ExecResult, maxChars: number): string {
  const parts: string[] = [];
  if (r.ok) {
    parts.push(r.value === undefined ? "(no return value)" : JSON.stringify(r.value, null, 2));
  } else {
    parts.push(`Error: ${r.error}`);
  }
  if (r.logs.length) parts.push(`--- console ---\n${r.logs.join("\n")}`);
  const footer = `--- ${r.calls} API call${r.calls === 1 ? "" : "s"} · ${r.ms} ms ---`;
  return `${truncate(parts.join("\n\n"), maxChars, "return less data, e.g. pick the fields you need")}\n\n${footer}`;
}

function truncate(s: string, max: number, hint: string): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[truncated: showing ${max} of ${s.length} characters; ${hint}]`;
}
