import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSpec } from "../src/spec.js";
import { buildTools } from "../src/tools.js";
import { apiNames, declareApi, jsName, schemaToTs } from "../src/typegen.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/petstore.yaml", import.meta.url));

describe("typegen", () => {
  it("makes valid, unique identifiers from operation names", () => {
    assert.equal(jsName("repos_list-for-org"), "reposListForOrg");
    assert.equal(jsName("get_by_id_pets"), "getByIdPets");
    assert.equal(jsName("2fa/verify"), "_2faVerify");
    const names = apiNames([{ name: "a-b" }, { name: "a_b" }] as never);
    assert.deepEqual([...names.keys()], ["aB", "aB2"]);
  });

  it("renders schemas as readable TypeScript", () => {
    assert.equal(schemaToTs({ type: ["string", "null"] }), "string | null");
    assert.equal(schemaToTs({ enum: ["open", "closed"] }), '"open" | "closed"');
    assert.equal(schemaToTs({ type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } }), "Array<string | number>");
    assert.equal(schemaToTs({ type: "object", additionalProperties: { type: "integer" } }), "Record<string, number>");
    assert.equal(
      schemaToTs({ type: "object", required: ["id"], properties: { id: { type: "string", description: "The id" }, "x-y": { type: "boolean" } } }),
      '{\n    /** The id */\n    id: string;\n    "x-y"?: boolean;\n  }',
    );
  });

  it("collapses deep schemas instead of printing them forever", () => {
    let s: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 10; i++) s = { type: "object", properties: { next: s } };
    const ts = schemaToTs(s as never);
    assert.match(ts, /next\?: \{ next\?: object \}/, "the deepest level is one line, then collapses");
    assert.ok(ts.split("\n").length < 20);
  });

  it("declares every operation with its args, return type and access level", async () => {
    const { tools } = buildTools(await loadSpec(FIXTURE), { allowWrites: true, include: [], exclude: [] });
    const d = declareApi(apiNames(tools));
    assert.match(d, /^declare const api: \{/);
    assert.match(d, /listPets\(args\?: \{/, "all-optional args make the parameter optional");
    assert.match(d, /getPet\(args: \{\n\s+petId: string;\n\s+\}\): Promise<\{\n\s+id: string;/);
    assert.match(d, /DELETE \/pets\/\{petId\} · DESTRUCTIVE/);
    assert.match(d, /listPets[\s\S]*?\): Promise<Array<\{|listPets[\s\S]*?\): Promise<\{[\s\S]*?\}\[\]>/);
    assert.doesNotMatch(d, /\* POST \/login\n\s+\* POST \/login/, "no duplicated summary line");
  });
});
