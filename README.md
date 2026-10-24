# tool-forge

Turn any OpenAPI spec into a **code-mode** MCP server.

```sh
npx -y github:moeealii/tool-forge serve https://petstore3.swagger.io/api/v3/openapi.json
```

Most OpenAPI-to-MCP converters give the model one tool per endpoint. Point one at a real API and the model has to pick from hundreds of tools. Every intermediate response lands in its context, and a five-step task takes five round trips.

tool-forge gives the model a typed `api` object instead, and lets it write the glue:

```js
const owner = "swamp-club", repo = "swamp";
const [info, releases, contributors] = await Promise.all([
  api.reposGet({ owner, repo }),
  api.reposListReleases({ owner, repo, per_page: 3 }),
  api.reposListContributors({ owner, repo, per_page: 5 }),
]);
return {
  stars: info.stargazers_count,
  latestReleases: releases.map((r) => r.tag_name),
  topContributors: contributors.map((c) => `${c.login} (${c.contributions})`),
};
```

Against GitHub's live API, that script made 3 calls in parallel in about half a second. The release data alone was over 52,000 characters of JSON. The model got back the ~400-character answer and nothing else.

Models write code more reliably than they juggle tool calls, and code can loop, branch, join and filter. tool-forge supplies the parts that make that safe against a real service.

## How it works

The MCP server exposes one tool, `execute`. Its description holds TypeScript declarations generated from the spec: one method per operation, with argument and return types, doc comments, and whether it is read-only or destructive:

```ts
declare const api: {
  /**
   * Get a pet
   * GET /pets/{petId} · read-only
   */
  getPet(args: {
    petId: string;
  }): Promise<{
    id: string;
    name: string;
    nickname?: string | null;
  }>;
};
```

APIs too large to describe in full (GitHub's is 1.3 MB of TypeScript) also get `search_api`. It ranks operations with BM25 over their summaries, names, tags and paths, folds plurals and maps verb synonyms (add → create), and returns only the matching declarations. Return types are kept compact: the nesting is deep enough to write code against without paying for every field of every nested object.

The model's script runs in a **QuickJS WebAssembly sandbox**:

- The only way out is `api.*`. There is no `fetch`, `require`, filesystem, `process` or timers, and `api` is frozen.
- Every `api` call goes back to the host, where credentials, rate limiting, retries and the audit log apply. **Secrets never enter the sandbox.**
- Each run has a heap limit (64 MB), a CPU deadline and wall-clock limit (60 s), and a call budget (50). Runaway loops are interrupted, and calls that never return time out.
- A failed call throws `ApiError` with `.status` and `.body`, so the script can handle a 404 itself. Uncaught errors come back with line numbers that match the script.
- `console.log` output is returned with the result. Large results are truncated with a hint to return less.

## Safety, unchanged from before

- **Read-only by default.** `POST`/`PUT`/`PATCH`/`DELETE` operations don't exist on `api` unless you pass `--allow-writes`. Scope further with `--include`/`--exclude` globs on operationId, tag or `"METHOD /path"`.
- **Secrets stay in the environment.** `--auth bearer:GITHUB_TOKEN` names a variable, never a value.
- **Polite under load.** A shared token-bucket rate limiter, retries with jittered backoff on 429/502/503/504 that honour `Retry-After`, and per-request timeouts. A `POST` or `PATCH` is only retried on 429 or a refused connection, never on a 5xx where it may already have been applied.
- **Audit log.** `--audit calls.jsonl` records every API call (secret query values redacted, argument names but not values) and every script run (duration, call count, outcome).

## Quick start

```sh
tool-forge types ./openapi.yaml        # the TypeScript the model will see
tool-forge exec  ./openapi.yaml script.js   # run a script yourself, exactly as the model would
tool-forge list  ./openapi.yaml        # operations, access level, and what was skipped and why
```

### Claude Code

```sh
claude mcp add github -e GITHUB_TOKEN=ghp_... -- \
  npx -y github:moeealii/tool-forge serve \
  https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json \
  --auth bearer:GITHUB_TOKEN --header "User-Agent:tool-forge"
```

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "immich": {
      "command": "npx",
      "args": ["-y", "github:moeealii/tool-forge", "serve", "http://nas.example.com:2283/api/spec.json",
               "--base-url", "http://nas.example.com:2283/api", "--auth", "header:x-api-key:IMMICH_API_KEY",
               "--audit", "/var/log/immich-mcp.jsonl"],
      "env": { "IMMICH_API_KEY": "..." }
    }
  }
}
```

## Options

| Flag | Default | |
|---|---|---|
| `--base-url <url>` | first `servers` entry | Relative server URLs resolve against the spec's URL |
| `--auth <spec>` | none | `bearer:ENV`, `header:Name:ENV`, `query:name:ENV`, `basic:USER_ENV:PASS_ENV`. Repeatable |
| `--header <Name:Value>` | | Static header on every request. Repeatable |
| `--allow-writes` | off | Put state-changing operations on `api` |
| `--include` / `--exclude <glob>` | | Repeatable |
| `--max-calls <n>` | 50 | API calls per script run |
| `--exec-timeout <ms>` | 60000 | Wall-clock limit per script run |
| `--memory-mb <n>` | 64 | Sandbox heap limit |
| `--max-chars <n>` | 50000 | Output returned to the model |
| `--inline-types <n>` | 20000 | Above this many characters of TypeScript, add `search_api` |
| `--rps <n>` / `--burst <n>` | 5 / 10 | Shared across all calls. `--rps 0` disables limiting |
| `--retries <n>` | 3 | |
| `--timeout <ms>` | 30000 | Per HTTP request |
| `--audit <file>` | | JSON Lines |

## How a spec becomes an API

- Path, query and header parameters become properties of `args`. The request body becomes `args.body`. Path-level parameters are inherited and operation-level ones override them.
- `$ref`s are inlined. Recursive schemas are cut off at the point of recursion.
- OpenAPI-only keywords are translated or removed: `nullable` becomes `| null`, `readOnly` properties are dropped from request bodies, and `Authorization`/`Cookie` parameters are never exposed, because auth is injected by the host.
- Query parameters follow the spec's `style`/`explode`. JSON, form-encoded and text bodies are supported. Operations that need `multipart/form-data` or binary uploads are listed as skipped, with the reason.

## As a library

```ts
import { apiNames, buildTools, createServer, Executor, loadSpec, runInSandbox } from "tool-forge";

const spec = await loadSpec("./openapi.yaml");
const { tools } = buildTools(spec, { allowWrites: false, include: [], exclude: [] });
const executor = new Executor({ baseUrl: "https://api.example.com", auth: [], rps: 5, burst: 10,
  retries: 3, timeoutMs: 30_000, maxResponseChars: 50_000 });

const result = await runInSandbox("return (await api.listPets()).length;", apiNames(tools), executor);
const server = createServer(tools, executor, { name: "pets", version: "1.0.0" });
```

## Limits

- OpenAPI 3.0 and 3.1. Convert Swagger 2 first, for example with `swagger2openapi`.
- Local `$ref`s only. Bundle multi-file specs first, for example with `redocly bundle`.
- stdio transport only.

## Development

```sh
npm install
npm test     # 47 tests: spec handling, HTTP policy, type generation, sandbox isolation and limits,
             # and end-to-end runs where a real MCP client drives the server over stdio
npm run build
```

MIT licensed.
