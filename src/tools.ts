import { deref, isObject, type Json, type JsonObject, type LoadedSpec } from "./spec.js";

export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;
export type Method = (typeof METHODS)[number];

const READ_METHODS = new Set<Method>(["get", "head", "options"]);
const IDEMPOTENT_METHODS = new Set<Method>(["get", "head", "options", "put", "delete"]);

export interface ParamBinding {
  /** Property name in the tool's input schema. */
  arg: string;
  /** Parameter name on the wire. */
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  style?: string;
  explode?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonObject & { type: "object" };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: true;
  };
  method: Method;
  path: string;
  operationId?: string;
  tags: string[];
  params: ParamBinding[];
  body?: { contentType: string; required: boolean };
  /** JSON schema of the success response, when the spec declares one. */
  responseSchema?: Json;
}

export interface SkippedOperation {
  method: Method;
  path: string;
  operationId?: string;
  reason: string;
}

export interface Policy {
  /** Allow tools that change state (anything other than GET/HEAD/OPTIONS). */
  allowWrites: boolean;
  /** Glob patterns matched against operationId, tool name, tag, or "METHOD /path". */
  include: string[];
  exclude: string[];
}

export const DEFAULT_POLICY: Policy = { allowWrites: false, include: [], exclude: [] };

const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
// Keywords that are OpenAPI-specific or only noise for a model reading the schema.
const STRIP_KEYS = new Set(["xml", "externalDocs", "example", "examples", "discriminator", "deprecated"]);

export function buildTools(spec: LoadedSpec, policy: Policy = DEFAULT_POLICY) {
  const tools: ToolDef[] = [];
  const skipped: SkippedOperation[] = [];
  const names = new Set<string>();
  const paths = isObject(spec.doc.paths) ? spec.doc.paths : {};

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec.doc, rawItem);
    if (!isObject(item)) continue;
    const shared = Array.isArray(item.parameters) ? item.parameters : [];

    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const operationId = typeof op.operationId === "string" ? op.operationId : undefined;
      const tags = Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : [];
      const where = { method, path, operationId };
      const name = uniqueName(names, toolName(method, path, operationId));
      const subjects = [name, `${method.toUpperCase()} ${path}`, ...tags, ...(operationId ? [operationId] : [])];

      if (policy.include.length && !subjects.some((s) => policy.include.some((g) => globMatch(g, s)))) {
        names.delete(name);
        continue; // filtered out on purpose: not worth reporting
      }
      if (subjects.some((s) => policy.exclude.some((g) => globMatch(g, s)))) {
        names.delete(name);
        continue;
      }
      if (!READ_METHODS.has(method) && !policy.allowWrites) {
        names.delete(name);
        skipped.push({ ...where, reason: "write operation (pass --allow-writes to enable)" });
        continue;
      }

      try {
        tools.push(buildTool(name, method, path, op, mergeParams(shared, op.parameters), tags));
      } catch (err) {
        names.delete(name);
        skipped.push({ ...where, reason: (err as Error).message });
      }
    }
  }
  return { tools, skipped };
}

function buildTool(
  name: string,
  method: Method,
  path: string,
  op: JsonObject,
  parameters: JsonObject[],
  tags: string[],
): ToolDef {
  const properties: JsonObject = {};
  const required: string[] = [];
  const params: ParamBinding[] = [];

  for (const p of parameters) {
    const where = p.in;
    if (where === "cookie") continue; // cookies are auth plumbing, not model input
    if (where !== "path" && where !== "query" && where !== "header") continue;
    if (typeof p.name !== "string") continue;
    // Auth headers are injected by tool-forge, never supplied by the model.
    if (where === "header" && /^(authorization|cookie)$/i.test(p.name)) continue;

    let arg = p.name;
    if (arg in properties || arg === "body") arg = `${where}_${p.name}`;
    const isRequired = where === "path" || p.required === true;
    const schema = isObject(p.schema) ? cleanSchema(p.schema, "request") : { type: "string" };
    const description = [p.description, where === "header" ? `(HTTP header ${p.name})` : undefined]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ");
    properties[arg] = description ? { ...(schema as JsonObject), description } : schema;
    if (isRequired) required.push(arg);
    params.push({
      arg,
      name: p.name,
      in: where,
      required: isRequired,
      style: typeof p.style === "string" ? p.style : undefined,
      explode: typeof p.explode === "boolean" ? p.explode : undefined,
    });
  }

  let body: ToolDef["body"];
  if (isObject(op.requestBody)) {
    const content = isObject(op.requestBody.content) ? op.requestBody.content : {};
    const contentType = pickContentType(Object.keys(content));
    if (!contentType) {
      throw new Error(`unsupported request body type(s): ${Object.keys(content).join(", ") || "none"}`);
    }
    const media = content[contentType];
    const schema = isObject(media) && isObject(media.schema) ? cleanSchema(media.schema, "request") : {};
    const bodyRequired = op.requestBody.required === true;
    properties.body = {
      ...(schema as JsonObject),
      description: [op.requestBody.description, `Request body (${contentType}).`]
        .filter((s) => typeof s === "string" && s)
        .join(" "),
    };
    if (bodyRequired) required.push("body");
    body = { contentType, required: bodyRequired };
  }

  const summary = typeof op.summary === "string" ? op.summary.trim() : "";
  const detail = typeof op.description === "string" ? op.description.trim() : "";
  const description = truncate(
    [summary, detail && detail !== summary ? detail : "", `${method.toUpperCase()} ${path}`]
      .filter(Boolean)
      .join("\n\n"),
    MAX_DESCRIPTION,
  );

  return {
    name,
    description,
    responseSchema: successSchema(op),
    inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: {
      title: summary || `${method.toUpperCase()} ${path}`,
      readOnlyHint: READ_METHODS.has(method),
      destructiveHint: method === "delete",
      idempotentHint: IDEMPOTENT_METHODS.has(method),
      openWorldHint: true,
    },
    method,
    path,
    operationId: typeof op.operationId === "string" ? op.operationId : undefined,
    tags,
    params,
    body,
  };
}

/** The JSON schema of the first 2xx (or default) response with a JSON body. */
function successSchema(op: JsonObject): Json | undefined {
  const responses = isObject(op.responses) ? op.responses : {};
  const codes = Object.keys(responses).sort();
  for (const code of [...codes.filter((c) => /^2/.test(c)), ...codes.filter((c) => c === "default")]) {
    const r = responses[code];
    const content = isObject(r) && isObject(r.content) ? r.content : {};
    const type = Object.keys(content).find((t) => /json/i.test(t));
    const media = type ? content[type] : undefined;
    if (isObject(media) && isObject(media.schema)) return cleanSchema(media.schema, "response");
  }
  return undefined;
}

/** Operation-level parameters override path-level ones with the same name+in. */
function mergeParams(shared: Json[], own: Json | undefined): JsonObject[] {
  const byKey = new Map<string, JsonObject>();
  for (const p of [...shared, ...(Array.isArray(own) ? own : [])]) {
    if (isObject(p)) byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

function pickContentType(types: string[]): string | undefined {
  const lower = types.map((t) => t.toLowerCase());
  const json = lower.findIndex((t) => t === "application/json" || /\+json$/.test(t) || t.endsWith("/json"));
  if (json >= 0) return types[json];
  const form = lower.indexOf("application/x-www-form-urlencoded");
  if (form >= 0) return types[form];
  const text = lower.findIndex((t) => t.startsWith("text/"));
  if (text >= 0) return types[text];
  return undefined; // multipart and binary uploads need a human in the loop
}

/**
 * Turn an OpenAPI schema into plain JSON Schema that MCP clients accept:
 * `nullable: true` becomes a `"null"` type, OpenAPI-only keywords go, and
 * `readOnly` properties are dropped from request bodies.
 */
export function cleanSchema(schema: Json, direction: "request" | "response"): Json {
  if (Array.isArray(schema)) return schema.map((s) => cleanSchema(s, direction));
  if (!isObject(schema)) return schema;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema)) {
    if (STRIP_KEYS.has(k) || k.startsWith("x-") || k === "nullable") continue;
    if (k === "properties" && isObject(v)) {
      const props: JsonObject = {};
      for (const [pk, pv] of Object.entries(v)) {
        if (direction === "request" && isObject(pv) && pv.readOnly === true) continue;
        props[pk] = cleanSchema(pv, direction);
      }
      out.properties = props;
      continue;
    }
    out[k] = cleanSchema(v, direction);
  }
  if (direction === "request" && Array.isArray(out.required) && isObject(out.properties)) {
    const props = out.properties;
    out.required = out.required.filter((r) => typeof r === "string" && r in props);
    if (out.required.length === 0) delete out.required;
  }
  if (schema.nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (!("type" in out)) return { anyOf: [out, { type: "null" }] };
  }
  delete out.readOnly;
  delete out.writeOnly;
  return out;
}

export function toolName(method: Method, path: string, operationId?: string): string {
  const base =
    operationId ??
    `${method}_${path.replace(/\{([^}]+)\}/g, "by_$1").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
  const clean = base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || method;
  return clean.slice(0, MAX_NAME);
}

function uniqueName(seen: Set<string>, name: string): string {
  let candidate = name;
  for (let i = 2; seen.has(candidate); i++) {
    const suffix = `_${i}`;
    candidate = name.slice(0, MAX_NAME - suffix.length) + suffix;
  }
  seen.add(candidate);
  return candidate;
}

/** `*` matches any run of characters; matching is case-insensitive. */
export function globMatch(glob: string, subject: string): boolean {
  const re = new RegExp(
    `^${glob.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
    "i",
  );
  return re.test(subject);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
