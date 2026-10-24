/**
 * Credentials come from environment variables only, so they never appear in
 * argv, config files, tool schemas, or the audit log.
 *
 *   bearer:API_TOKEN               Authorization: Bearer $API_TOKEN
 *   header:X-Api-Key:API_KEY       X-Api-Key: $API_KEY
 *   query:api_key:API_KEY          ?api_key=$API_KEY
 *   basic:API_USER:API_PASSWORD    Authorization: Basic base64($API_USER:$API_PASSWORD)
 */
export type Auth =
  | { kind: "bearer"; env: string }
  | { kind: "header"; name: string; env: string }
  | { kind: "query"; name: string; env: string }
  | { kind: "basic"; userEnv: string; passwordEnv: string };

export function parseAuth(spec: string): Auth {
  const parts = spec.split(":");
  const [kind] = parts;
  if (kind === "bearer" && parts.length === 2) return { kind, env: parts[1]! };
  if ((kind === "header" || kind === "query") && parts.length === 3) {
    return { kind, name: parts[1]!, env: parts[2]! };
  }
  if (kind === "basic" && parts.length === 3) {
    return { kind, userEnv: parts[1]!, passwordEnv: parts[2]! };
  }
  throw new Error(
    `invalid --auth "${spec}". Use bearer:ENV, header:Name:ENV, query:name:ENV or basic:USER_ENV:PASS_ENV`,
  );
}

export function envNames(auth: Auth): string[] {
  return auth.kind === "basic" ? [auth.userEnv, auth.passwordEnv] : [auth.env];
}

/** Fail at startup, not on the first tool call, when a credential is missing. */
export function checkAuthEnv(auths: Auth[], env: NodeJS.ProcessEnv = process.env): void {
  const missing = auths.flatMap(envNames).filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing environment variable(s) for --auth: ${missing.join(", ")}`);
}

export function applyAuth(
  auths: Auth[],
  headers: Headers,
  url: URL,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const auth of auths) {
    switch (auth.kind) {
      case "bearer":
        headers.set("authorization", `Bearer ${env[auth.env] ?? ""}`);
        break;
      case "header":
        headers.set(auth.name, env[auth.env] ?? "");
        break;
      case "query":
        url.searchParams.set(auth.name, env[auth.env] ?? "");
        break;
      case "basic": {
        const raw = `${env[auth.userEnv] ?? ""}:${env[auth.passwordEnv] ?? ""}`;
        headers.set("authorization", `Basic ${Buffer.from(raw).toString("base64")}`);
        break;
      }
    }
  }
}

/** Query parameter names whose values must never be written anywhere. */
export function secretQueryNames(auths: Auth[]): Set<string> {
  return new Set(auths.flatMap((a) => (a.kind === "query" ? [a.name.toLowerCase()] : [])));
}
