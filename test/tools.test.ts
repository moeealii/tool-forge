import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultServerUrl, deref, loadSpec } from "../src/spec.js";
import { buildTools, cleanSchema, globMatch, toolName } from "../src/tools.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/petstore.yaml", import.meta.url));

describe("spec", () => {
  it("fills server variables from their defaults", async () => {
    const spec = await loadSpec(FIXTURE);
    assert.equal(defaultServerUrl(spec), "https://ca.petstore.example/v1");
  });

  it("cuts recursive $refs instead of looping forever", async () => {
    const spec = await loadSpec(FIXTURE);
    const pet = deref(spec.doc, { $ref: "#/components/schemas/Pet" }) as any;
    const parent = pet.properties.category.properties.parent;
    assert.equal(parent.type, "object");
    assert.match(parent.description, /recursive Category/);
  });

  it("rejects Swagger 2 with a pointer to a converter", async () => {
    const { writeFile, mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(await mkdtemp(join(tmpdir(), "tf-")), "swagger.json");
    await writeFile(file, JSON.stringify({ swagger: "2.0", paths: {} }));
    await assert.rejects(loadSpec(file), /Swagger 2.0 is not supported/);
  });
});

describe("buildTools", () => {
  it("is read-only by default and says why writes were skipped", async () => {
    const { tools, skipped } = buildTools(await loadSpec(FIXTURE));
    assert.deepEqual(tools.map((t) => t.name), ["listPets", "getPet", "get_search"]);
    assert.ok(skipped.some((s) => s.operationId === "deletePet" && /--allow-writes/.test(s.reason)));
  });

  it("exposes writes with honest annotations when allowed", async () => {
    const { tools, skipped } = buildTools(await loadSpec(FIXTURE), { allowWrites: true, include: [], exclude: [] });
    const del = tools.find((t) => t.name === "deletePet")!;
    assert.deepEqual(
      [del.annotations.readOnlyHint, del.annotations.destructiveHint, del.annotations.idempotentHint],
      [false, true, true],
    );
    // multipart uploads are skipped, with the reason
    assert.match(skipped.find((s) => s.operationId === "uploadPhoto")!.reason, /multipart\/form-data/);
  });

  it("filters by tag, operationId and METHOD /path globs", async () => {
    const spec = await loadSpec(FIXTURE);
    const writes = { allowWrites: true, exclude: [] };
    assert.deepEqual(buildTools(spec, { ...writes, include: ["auth"] }).tools.map((t) => t.name), ["login"]);
    assert.deepEqual(buildTools(spec, { ...writes, include: ["DELETE /pets/*"] }).tools.map((t) => t.name), ["deletePet"]);
    const noDeletes = buildTools(spec, { allowWrites: true, include: [], exclude: ["delete*"] }).tools;
    assert.ok(!noDeletes.some((t) => t.name === "deletePet"));
  });

  it("builds a clean input schema", async () => {
    const { tools } = buildTools(await loadSpec(FIXTURE), { allowWrites: true, include: [], exclude: [] });
    const list = tools.find((t) => t.name === "listPets")!;
    const props = list.inputSchema.properties as any;
    assert.deepEqual(Object.keys(props), ["tag", "limit", "filter", "X-Request-Id"]); // Authorization header dropped
    assert.match(props["X-Request-Id"].description, /HTTP header/);
    assert.equal(list.inputSchema.additionalProperties, false);

    const create = tools.find((t) => t.name === "createPet")!;
    const body = (create.inputSchema.properties as any).body;
    assert.equal(body.properties.id, undefined, "readOnly id is not something the model sends");
    assert.deepEqual(body.required, ["name"]);
    assert.deepEqual(body.properties.nickname.type, ["string", "null"]);
    assert.equal(body.properties.name.example, undefined);
    assert.deepEqual(create.inputSchema.required, ["body"]);

    const get = tools.find((t) => t.name === "getPet")!;
    assert.deepEqual(get.inputSchema.required, ["petId"], "path-level parameters are inherited");

    const search = tools.find((t) => t.name === "get_search")!;
    assert.deepEqual(Object.keys(search.inputSchema.properties as object), ["query_body"], "no clash with body");
  });
});

describe("helpers", () => {
  it("names operations without an operationId from the method and path", () => {
    assert.equal(toolName("get", "/users/{id}/repos"), "get_users_by_id_repos");
    assert.equal(toolName("get", "/x", "weird name!".repeat(10)).length, 64);
  });

  it("matches globs case-insensitively", () => {
    assert.ok(globMatch("GET /pets*", "get /pets/{petId}"));
    assert.ok(!globMatch("pets", "petsitter"));
  });

  it("turns nullable without a type into anyOf", () => {
    assert.deepEqual(cleanSchema({ nullable: true, enum: ["a"] }, "request"), {
      anyOf: [{ enum: ["a"] }, { type: "null" }],
    });
  });
});

describe("discovery search", async () => {
  const { searchTools, terms } = await import("../src/discover.js");

  it("folds plurals, camelCase and aliases", () => {
    assert.deepEqual(terms("listPets for the repositories"), ["list", "pet", "repo"]);
    assert.deepEqual(terms("GET /repos/{owner}/{repo}/issues"), ["get", "repo", "issue"]);
  });

  it("finds operations by intent, including verb synonyms", async () => {
    const { tools } = buildTools(await loadSpec(FIXTURE), { allowWrites: true, include: [], exclude: [] });
    assert.equal(searchTools(tools, "remove a pet", 1)[0]!.name, "deletePet");
    assert.equal(searchTools(tools, "add a new pet", 1)[0]!.name, "createPet");
    assert.equal(searchTools(tools, "show me the pets", 1)[0]!.name, "listPets");
    assert.deepEqual(searchTools(tools, "the of and", 5), []);
  });
});
