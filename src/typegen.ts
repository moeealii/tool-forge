import { isObject, type Json } from "./spec.js";
import type { ToolDef } from "./tools.js";

/**
 * Generates the TypeScript the model reads before writing code: one method per
 * operation on a global `api` object, with argument and return types derived
 * from the OpenAPI schemas. It is documentation for the model, so readability
 * wins over completeness: deep or huge schemas collapse to `object`/`unknown`.
 */

/** How much of a schema to render. */
interface Budget {
  /** Objects nested deeper than this are shown shallowly: scalar fields keep their types, nested ones become `object`. */
  maxDepth: number;
  /** Property doc comments are kept down to this depth. */
  docDepth: number;
}

const ARGS: Budget = { maxDepth: 4, docDepth: 4 };
/** Return types only need enough shape to write code against; GitHub's issue object alone is ~40 KB of TS at full depth. */
const RETURNS: Budget = { maxDepth: 1, docDepth: 1 };
const MAX_PROPS = 40;
const COMPACT_PROPS = 12;

/** A valid JS identifier for an operation, e.g. `repos/list-for-org` → `reposListForOrg`. */
export function jsName(toolName: string): string {
  const parts = toolName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = parts.map((p, i) => (i === 0 ? p[0]!.toLowerCase() + p.slice(1) : p[0]!.toUpperCase() + p.slice(1))).join("");
  return /^[0-9]/.test(camel) ? `_${camel}` : camel || "op";
}

/** Assign each tool a unique `api.<name>`. */
export function apiNames(tools: ToolDef[]): Map<string, ToolDef> {
  const out = new Map<string, ToolDef>();
  for (const t of tools) {
    let name = jsName(t.name);
    for (let i = 2; out.has(name); i++) name = `${jsName(t.name)}${i}`;
    out.set(name, t);
  }
  return out;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** Render a JSON schema as a TypeScript type expression. */
export function schemaToTs(schema: Json | undefined, depth = 0, indent = "  ", budget: Budget = ARGS): string {
  if (!isObject(schema)) return "unknown";

  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.slice(0, 30).map((v) => JSON.stringify(v)).join(" | ");
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  for (const k of ["oneOf", "anyOf"] as const) {
    const options = schema[k];
    if (Array.isArray(options) && options.length) {
      return [...new Set(options.slice(0, 8).map((o) => schemaToTs(o, depth, indent, budget)))].join(" | ");
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    return schema.allOf.slice(0, 8).map((o) => schemaToTs(o, depth, indent, budget)).join(" & ");
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const rendered = types.map((t) => {
    switch (t) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        // Arrays don't count as a level: `Issue[]` should show Issue's fields.
        const item = schemaToTs(schema.items, depth, indent, budget);
        return /[|& \n]/.test(item) ? `Array<${item}>` : `${item}[]`;
      }
      case "object":
      case undefined:
        if (depth > budget.maxDepth) return isObject(schema.properties) || schema.type === "object" ? "object" : "unknown";
        return objectToTs(schema, depth, indent, budget);
      default:
        return "unknown";
    }
  });
  return [...new Set(rendered)].join(" | ");
}

function objectToTs(schema: Record<string, Json>, depth: number, indent: string, budget: Budget): string {
  const props = isObject(schema.properties) ? Object.entries(schema.properties) : [];
  if (props.length === 0) {
    if (isObject(schema.additionalProperties)) {
      return `Record<string, ${schemaToTs(schema.additionalProperties, depth + 1, indent, budget)}>`;
    }
    return schema.type === "object" || "additionalProperties" in schema ? "Record<string, unknown>" : "unknown";
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  if (depth >= budget.maxDepth && depth > 0) {
    // The last expanded level goes on one line: enough to see the field names
    // and scalar types, without paying for every nested object in full.
    const shown = props.slice(0, COMPACT_PROPS)
      .map(([k, v]) => `${key(k)}${required.has(k) ? "" : "?"}: ${schemaToTs(v, depth + 1, indent, budget)}`);
    const more = props.length > COMPACT_PROPS ? `; /* +${props.length - COMPACT_PROPS} more */` : "";
    return `{ ${shown.join("; ")}${more} }`;
  }
  const inner = indent + "  ";
  const lines = props.slice(0, MAX_PROPS).map(([k, v]) => {
    const doc = depth < budget.docDepth && isObject(v) && typeof v.description === "string"
      ? docLine(v.description, inner)
      : "";
    return `${doc}${inner}${key(k)}${required.has(k) ? "" : "?"}: ${schemaToTs(v, depth + 1, inner, budget)};`;
  });
  if (props.length > MAX_PROPS) lines.push(`${inner}// ...${props.length - MAX_PROPS} more properties`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

function docLine(text: string, indent: string): string {
  const one = text.replace(/\s+/g, " ").replace(/\*\//g, "* /").trim();
  return one ? `${indent}/** ${one.length > 160 ? `${one.slice(0, 157)}...` : one} */\n` : "";
}

/** The declaration of one `api` method, with its doc comment. */
export function declareOperation(name: string, tool: ToolDef, indent = "  "): string {
  const where = `${tool.method.toUpperCase()} ${tool.path}`;
  const summary = tool.annotations.title === where ? "" : tool.annotations.title;
  const detail = tool.description.split("\n\n").slice(1, -1).join(" ");
  const flags = [
    where,
    tool.annotations.destructiveHint ? "DESTRUCTIVE" : tool.annotations.readOnlyHint ? "read-only" : "writes data",
  ].join(" · ");
  const doc = [summary, detail, flags]
    .filter(Boolean)
    .map((l) => `${indent} * ${l.replace(/\s+/g, " ").replace(/\*\//g, "* /").slice(0, 300)}`)
    .join("\n");

  const props = isObject(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const hasArgs = Object.keys(props).length > 0;
  const required = Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0;
  const args = hasArgs ? `args${required ? "" : "?"}: ${schemaToTs(tool.inputSchema, 0, indent)}` : "";
  const returns = tool.responseSchema === undefined ? "unknown" : schemaToTs(tool.responseSchema, 0, indent, RETURNS);
  return `${indent}/**\n${doc}\n${indent} */\n${indent}${name}(${args}): Promise<${returns}>;`;
}

/** The full `declare const api` block for a set of operations. */
export function declareApi(names: Map<string, ToolDef>, only?: string[]): string {
  const entries = only ? only.map((n) => [n, names.get(n)!] as const) : [...names];
  const body = entries.map(([n, t]) => declareOperation(n, t)).join("\n\n");
  return `declare const api: {\n${body}\n};`;
}
