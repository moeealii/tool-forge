import type { ToolDef } from "./tools.js";

/**
 * Large APIs (GitHub has ~1,200 operations) blow past what a model can usefully
 * hold in its tool list. Discovery mode exposes two tools instead: search the
 * catalogue, then call an operation by name. Schemas are only sent for the
 * operations the model actually looks at.
 */
export const FIND_TOOL = "find_operations";
export const CALL_TOOL = "call_operation";

export interface Match {
  name: string;
  method: string;
  path: string;
  description: string;
  inputSchema: ToolDef["inputSchema"];
  readOnly: boolean;
}

const STOP = new Set(["a", "an", "the", "of", "for", "to", "in", "on", "by", "and", "or", "with", "my", "all", "is", "me"]);
const ALIASES: Record<string, string> = { repository: "repo", repositories: "repo", pr: "pull", prs: "pull" };

/** Lowercase words with camelCase split, stop words dropped and plurals folded. */
export function terms(s: string): string[] {
  return s
    .replace(/\{[^}]*\}/g, " ") // path parameters are noise: every repo route has {owner}
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => ALIASES[w] ?? w)
    .map((w) => (w.length > 4 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w))
    .map((w) => ALIASES[w] ?? w);
}

// Where a word appears matters: the summary and name say what an operation *is*,
// the description mostly says what it touches.
const FIELD_WEIGHTS: [(t: ToolDef) => string, number][] = [
  [(t) => t.annotations.title, 3],
  [(t) => t.operationId ?? t.name, 2],
  [(t) => t.tags.join(" "), 1.5],
  [(t) => t.path, 1],
  [(t) => t.description.split("\n\n").slice(1, -1).join(" ").slice(0, 300), 0.5],
];

// People say "add" and "remove"; APIs say "create" and "delete". Applied to the query only.
const VERB_SYNONYMS: Record<string, string[]> = {
  add: ["create"],
  new: ["create"],
  make: ["create"],
  remove: ["delete"],
  fetch: ["get"],
  show: ["get", "list"],
  find: ["list", "search", "get"],
  edit: ["update"],
  change: ["update"],
  modify: ["update"],
};

interface Indexed {
  tool: ToolDef;
  tf: Map<string, number>;
  length: number;
  /** Terms of the summary line, used to prefer operations that are exactly what was asked. */
  title: Set<string>;
}

const indexCache = new WeakMap<ToolDef[], { docs: Indexed[]; df: Map<string, number>; avgLength: number }>();

function index(tools: ToolDef[]) {
  const cached = indexCache.get(tools);
  if (cached) return cached;
  const df = new Map<string, number>();
  const docs = tools.map((tool) => {
    const tf = new Map<string, number>();
    let length = 0;
    for (const [field, weight] of FIELD_WEIGHTS) {
      for (const w of terms(field(tool))) {
        tf.set(w, (tf.get(w) ?? 0) + weight);
        length += weight;
      }
    }
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    return { tool, tf, length, title: new Set(terms(tool.annotations.title)) };
  });
  const avgLength = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const built = { docs, df, avgLength };
  indexCache.set(tools, built);
  return built;
}

/**
 * BM25 over weighted fields. Two adjustments on top: operations matching more of
 * the query rank higher, and so do operations whose summary is *only* what was
 * asked for ("Get a repository" beats "Get all repository rulesets").
 */
export function searchTools(tools: ToolDef[], query: string, limit: number): Match[] {
  const groups = [...new Set(terms(query))].map((w) => [w, ...(VERB_SYNONYMS[w] ?? [])]);
  if (groups.length === 0) return [];
  const { docs, df, avgLength } = index(tools);
  const k1 = 1.2;
  const b = 0.75;
  const bm25 = (d: Indexed, w: string) => {
    const tf = d.tf.get(w);
    if (!tf) return 0;
    const n = df.get(w) ?? 0;
    const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
    return (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avgLength));
  };
  const scored = docs.map((d) => {
    let score = 0;
    let hits = 0;
    const matched = new Set<string>();
    for (const group of groups) {
      let best = 0;
      for (const [i, w] of group.entries()) {
        const s = bm25(d, w) * (i === 0 ? 1 : 0.8); // a synonym counts a little less
        if (s > best) best = s;
        if (s > 0) matched.add(w);
      }
      if (best > 0) hits++;
      score += best;
    }
    const titleCovered = d.title.size ? [...d.title].filter((w) => matched.has(w)).length / d.title.size : 0;
    return { t: d.tool, score: score * (hits / groups.length) * (0.5 + 0.5 * titleCovered) };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.t.path.length - b.t.path.length)
    .slice(0, limit)
    .map(({ t }) => ({
      name: t.name,
      method: t.method.toUpperCase(),
      path: t.path,
      description: t.description,
      inputSchema: t.inputSchema,
      readOnly: t.annotations.readOnlyHint,
    }));
}

export function discoveryTools(tools: ToolDef[], apiName: string) {
  const writes = tools.some((t) => !t.annotations.readOnlyHint);
  return [
    {
      name: FIND_TOOL,
      description:
        `Search the ${tools.length} operations of the ${apiName} API. Returns the best matches with ` +
        `their input schemas. Call this first, then use ${CALL_TOOL} with an exact name.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: 'What you want to do, e.g. "list open pull requests"' },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { title: "Find API operations", readOnlyHint: true, openWorldHint: false },
    },
    {
      name: CALL_TOOL,
      description: `Call one ${apiName} API operation by the exact name returned from ${FIND_TOOL}.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: `Operation name from ${FIND_TOOL}` },
          arguments: { type: "object", description: "Arguments matching that operation's input schema" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: {
        title: "Call an API operation",
        readOnlyHint: !writes,
        destructiveHint: tools.some((t) => t.annotations.destructiveHint),
        openWorldHint: true,
      },
    },
  ];
}
