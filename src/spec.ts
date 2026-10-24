import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface LoadedSpec {
  doc: JsonObject;
  /** Where the spec came from; used to resolve relative server URLs. */
  source: string;
}

/** Load an OpenAPI 3.x document from a file path or http(s) URL (JSON or YAML). */
export async function loadSpec(source: string): Promise<LoadedSpec> {
  const text = /^https?:\/\//i.test(source)
    ? await fetchText(source)
    : await readFile(source, "utf8");
  const doc = parseYaml(text) as unknown; // YAML is a superset of JSON
  if (!isObject(doc)) throw new Error(`${source}: not an OpenAPI document`);
  if (typeof doc.swagger === "string") {
    throw new Error(
      `${source}: Swagger ${doc.swagger} is not supported; convert it to OpenAPI 3 first (e.g. with swagger2openapi)`,
    );
  }
  if (typeof doc.openapi !== "string" || !doc.openapi.startsWith("3.")) {
    throw new Error(`${source}: expected an OpenAPI 3.x document (missing "openapi: 3.x")`);
  }
  return { doc, source };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return res.text();
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Follow a local JSON pointer such as `#/components/schemas/Pet`. */
export function resolvePointer(doc: JsonObject, ref: string): Json {
  if (!ref.startsWith("#")) {
    throw new Error(`external $ref is not supported: ${ref}`);
  }
  let node: Json = doc;
  for (const raw of ref.slice(1).split("/").filter(Boolean)) {
    const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(node)) node = node[Number(key)] ?? null;
    else if (isObject(node)) node = node[key] ?? null;
    else node = null;
    if (node === null) throw new Error(`unresolvable $ref: ${ref}`);
  }
  return node;
}

/**
 * Inline every local `$ref` reachable from `node`. A ref that points back into
 * its own chain (a recursive schema) is cut off with a short description, so
 * the result is always a finite tree that can be serialised as a tool schema.
 */
export function deref(doc: JsonObject, node: Json, chain: string[] = []): Json {
  if (Array.isArray(node)) return node.map((n) => deref(doc, n, chain));
  if (!isObject(node)) return node;
  const ref = node.$ref;
  if (typeof ref === "string") {
    if (chain.includes(ref)) {
      const name = ref.split("/").pop();
      return { type: "object", description: `(recursive ${name}; nesting not expanded)` };
    }
    const target = deref(doc, resolvePointer(doc, ref), [...chain, ref]);
    // OpenAPI 3.1 allows siblings next to $ref (e.g. a description override).
    const { $ref: _ignored, ...siblings } = node;
    return isObject(target) ? { ...target, ...deref(doc, siblings, chain) as JsonObject } : target;
  }
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(node)) out[k] = deref(doc, v, chain);
  return out;
}

/** The first server URL with its `{variables}` filled from their defaults. */
export function defaultServerUrl(spec: LoadedSpec): string | undefined {
  const servers = spec.doc.servers;
  if (!Array.isArray(servers) || !isObject(servers[0])) return undefined;
  const server = servers[0];
  if (typeof server.url !== "string") return undefined;
  const vars = isObject(server.variables) ? server.variables : {};
  const url = server.url.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const v = vars[name];
    return isObject(v) && typeof v.default === "string" ? v.default : `{${name}}`;
  });
  // Relative server URLs ("/v1") are relative to where the spec was fetched from.
  if (/^https?:\/\//i.test(url)) return url;
  if (/^https?:\/\//i.test(spec.source)) return new URL(url, spec.source).toString();
  return undefined;
}
