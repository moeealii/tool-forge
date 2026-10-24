import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CALL_TOOL, discoveryTools, FIND_TOOL, searchTools } from "./discover.js";
import type { Executor } from "./http.js";
import type { ToolDef } from "./tools.js";

export interface ServerOptions {
  name: string;
  version: string;
  /** Expose find/call meta-tools instead of one tool per operation. */
  discover: boolean;
  /** Cap on characters returned by find_operations, to protect the model's context. */
  maxResponseChars?: number;
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

/** An MCP server exposing the allowed OpenAPI operations, directly or via discovery. */
export function createServer(tools: ToolDef[], executor: Executor, opts: ServerOptions): Server {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const server = new Server({ name: opts.name, version: opts.version }, { capabilities: { tools: {} } });

  const listed = opts.discover
    ? discoveryTools(tools, opts.name)
    : tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (opts.discover && name === FIND_TOOL) {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
      const matches = searchTools(tools, query, limit);
      if (matches.length === 0) return text(`No operations match "${query}". Try other words.`);
      const out = JSON.stringify(matches, null, 2);
      const max = opts.maxResponseChars ?? 50_000;
      return text(out.length <= max ? out : `${out.slice(0, max)}\n[truncated; ask for fewer results with "limit"]`);
    }

    let tool: ToolDef | undefined;
    let callArgs: Record<string, unknown> = args;
    if (opts.discover) {
      if (name !== CALL_TOOL) return text(`Unknown tool: ${name}`, true);
      tool = typeof args.name === "string" ? byName.get(args.name) : undefined;
      if (!tool) return text(`Unknown operation: ${String(args.name)}. Use ${FIND_TOOL} to get exact names.`, true);
      callArgs = (args.arguments as Record<string, unknown> | undefined) ?? {};
    } else {
      tool = byName.get(name);
      if (!tool) return text(`Unknown tool: ${name}`, true);
    }

    const result = await executor.call(tool, callArgs);
    return text(result.text, !result.ok);
  });

  return server;
}
