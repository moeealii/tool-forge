# tool-forge

Turn any OpenAPI spec into an MCP server that is safe to hand to an agent.

```sh
npx -y github:moeealii/tool-forge serve https://petstore3.swagger.io/api/v3/openapi.json
```

Most OpenAPI-to-MCP converters do the easy part, one tool per endpoint, and stop there. Then you point one at a real API and the agent gets 1,200 tools it can't choose between, a `DELETE` it shouldn't have, and a token pasted into a config file. tool-forge is built around the parts that matter once an agent is calling a real service:

- **Read-only by default.** `POST`/`PUT`/`PATCH`/`DELETE` are only exposed with `--allow-writes`, and each tool carries honest MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so clients can ask before acting.
- **Discovery mode for big APIs.** Above 40 operations the model gets two tools, `find_operations` and `call_operation`, instead of hundreds. Search is BM25 over each operation's summary, name, tags and path, with plural folding and verb synonyms, so "add a comment to an issue" finds `issues/create-comment`. Schemas are sent only for the matches.
- **Secrets stay in the environment.** `--auth bearer:GITHUB_TOKEN` names a variable, never a value. Credentials are never in argv, tool schemas, or logs.
- **Polite under load.** A shared token-bucket rate limiter, retries with jittered backoff on 429/502/503/504 that honour `Retry-After`, and per-attempt timeouts. A `POST` or `PATCH` is only retried on 429 or a refused connection, never on a 5xx where it may already have been applied.
- **Audit log.** `--audit calls.jsonl` writes one line per call: tool, method, URL with secret query values redacted, status, attempts, latency. Argument names are recorded, values are not.
- **Context-friendly output.** JSON is pretty-printed, huge responses are cut with a note telling the model to paginate, binary bodies are described instead of dumped.

## Quick start

See what a spec would expose:

```console
$ npx -y github:moeealii/tool-forge list https://petstore3.swagger.io/api/v3/openapi.json
8 tool(s):
  findPetsByStatus  read   GET    /pet/findByStatus
  findPetsByTags    read   GET    /pet/findByTags
  getPetById        read   GET    /pet/{petId}
  ...
11 skipped:
  PUT    /pet: write operation (pass --allow-writes to enable)
  ...
```

Try one call, or print the exact HTTP request without sending it:

```sh
tool-forge call ./openapi.yaml getPetById '{"petId": 1}'
tool-forge call ./openapi.yaml getPetById '{"petId": 1}' --dry-run
```

### Claude Code

```sh
claude mcp add github -e GITHUB_TOKEN=ghp_... -- \
  npx -y github:moeealii/tool-forge serve \
  https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json \
  --auth bearer:GITHUB_TOKEN --header "User-Agent:tool-forge"
```

GitHub's spec has about 1,200 operations, so this starts in discovery mode automatically. Only the 651 read-only ones are exposed until you add `--allow-writes`.

### Claude Desktop, Cursor and other clients

```json
{
  "mcpServers": {
    "immich": {
      "command": "npx",
      "args": ["-y", "github:moeealii/tool-forge", "serve", "http://nas.local:2283/api/spec.json",
               "--base-url", "http://nas.local:2283/api", "--auth", "header:x-api-key:IMMICH_API_KEY",
               "--include", "search*", "--include", "albums*", "--audit", "/var/log/immich-mcp.jsonl"],
      "env": { "IMMICH_API_KEY": "..." }
    }
  }
}
```

## Narrowing what the agent can do

`--include` and `--exclude` take globs matched against the operationId, tool name, tag, or `"METHOD /path"`:

```sh
tool-forge serve api.yaml --allow-writes --include 'issues/*' --exclude '*delete*'
tool-forge serve api.yaml --include 'GET /repos/*'
```

Even with `--allow-writes`, scoping a server to the one job the agent is doing is the best safety measure you have.

## Options

| Flag | Default | |
|---|---|---|
| `--base-url <url>` | first `servers` entry | Relative server URLs resolve against the spec's URL |
| `--auth <spec>` | none | `bearer:ENV`, `header:Name:ENV`, `query:name:ENV`, `basic:USER_ENV:PASS_ENV`. Repeatable |
| `--header <Name:Value>` | | Static header on every request. Repeatable |
| `--allow-writes` | off | Expose state-changing operations |
| `--include` / `--exclude <glob>` | | Repeatable |
| `--discover auto\|on\|off` | `auto` | `auto` switches on above 40 operations |
| `--rps <n>` / `--burst <n>` | 5 / 10 | Shared across all tools. `--rps 0` disables limiting |
| `--retries <n>` | 3 | |
| `--timeout <ms>` | 30000 | Per attempt |
| `--max-chars <n>` | 50000 | Longer responses are truncated with a note |
| `--audit <file>` | | JSON Lines |

## How a spec becomes tools

- Path, query and header parameters become top-level properties. The request body becomes `body`. Path-level parameters are inherited and operation-level ones override them.
- `$ref`s are inlined. Recursive schemas are cut off at the point of recursion, not expanded forever.
- OpenAPI-only keywords are translated or removed: `nullable` becomes a `"null"` type, `readOnly` properties are dropped from request bodies, `example`, `xml` and `x-*` go.
- `Authorization` and `Cookie` parameters are never exposed to the model, because auth is injected by tool-forge.
- Query parameters follow the spec's `style`/`explode` (`form`, `deepObject`, `pipeDelimited`, `spaceDelimited`).
- JSON, form-encoded and text bodies are supported. Operations that need `multipart/form-data` or binary uploads are listed as skipped, with the reason.

## As a library

```ts
import { buildTools, createServer, Executor, loadSpec } from "tool-forge";

const spec = await loadSpec("./openapi.yaml");
const { tools } = buildTools(spec, { allowWrites: false, include: ["pets"], exclude: [] });
const executor = new Executor({ baseUrl: "https://api.example.com", auth: [], rps: 5, burst: 10,
  retries: 3, timeoutMs: 30_000, maxResponseChars: 50_000 });
const server = createServer(tools, executor, { name: "pets", version: "1.0.0", discover: false });
```

## Limits

- OpenAPI 3.0 and 3.1. Convert Swagger 2 first, for example with `swagger2openapi`.
- Local `$ref`s only (`#/components/...`). Bundle multi-file specs first, for example with `redocly bundle`.
- stdio transport only.

## Development

```sh
npm install
npm test          # unit tests plus end-to-end tests: a real MCP client, over stdio, against a local HTTP API
npm run build
```

MIT licensed.
