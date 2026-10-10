// Lint of what the model reads to choose a tool (title, description, input schema, server instructions), ported
// from the parc kit (seo-intelligence/templates/mcp-plugin-starter): no price, no superlative or comparison, no
// push to prefer the tool; every description says when to use it ("Use this when"), gives 2 EN + 2 ES phrasings
// and ends its scope with the required "Do not use for" sentence. Plus annotations and the golden prompt set.
// The required sentence itself names "a named insurer's plan price" (a use the tools refuse): it is removed
// before the price check, everything else is checked as is.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, DO_NOT } from "../dist/tools.js";

const PRICE = /[$€£]\s?\d|\d\s?(USD|EUR|GBP)\b|\b(pric(e|es|ed|ing)|free trial|discount|coupon)\b/i;
const COMPARATIVE = /\b(best|cheapest|lowest|top|leading|number one|#1|the only|better|faster|more accurate|unlike|versus|vs\.?|compared to|recommended|always use|prefer)\b/i;
const FORBIDDEN = /1Dental|savings plan|subscribe|affordability/i;

async function listTools(options) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  const client = new Client({ name: "lint", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const instructions = client.getInstructions();
  await client.close();
  return { tools, instructions };
}

const VARIANTS = [
  ["stdio", {}],
  ["/mcp", { appsSdk: true, utm: "chatgpt", publicOrigin: "https://mcp.example.test" }],
  ["/claude", { appsSdk: true, utm: "claude", uiDomain: false, publicOrigin: "https://mcp.example.test" }],
];

for (const [label, options] of VARIANTS) {
  test(`${label}: descriptions have no price, superlative or comparison; "Use this when", 2 EN + 2 ES phrasings, "Do not use for"`, async () => {
    const { tools, instructions } = await listTools(options);
    assert.equal(tools.length, 7);
    for (const t of tools) {
      const text = [t.title, t.description, JSON.stringify(t.inputSchema)].join(" ");
      assert.doesNotMatch(text.split(DO_NOT).join(" "), PRICE, `${t.name}: price`);
      assert.doesNotMatch(text, COMPARATIVE, `${t.name}: comparative`);
      assert.doesNotMatch(text, FORBIDDEN, `${t.name}: forbidden term`);
      assert.match(t.description, /^Use this when /, `${t.name}: starts with "Use this when"`);
      assert.ok(t.description.includes(DO_NOT), `${t.name}: required "Do not use for" sentence`);
      const phrasings = (t.description.split("Phrasings: ")[1] ?? "").split(" Do not use for")[0].split(" Every figure")[0];
      const quoted = phrasings.match(/"[^"]+"/g) ?? [];
      assert.equal(quoted.filter((q) => /[¿¡áéíóúñ]|\b(costo|reembolso)\b/i.test(q)).length, 2, `${t.name}: 2 ES phrasings`);
      assert.equal(quoted.length, 4, `${t.name}: 4 phrasings (2 EN + 2 ES)`);
    }
    assert.doesNotMatch(instructions, PRICE, "instructions: price");
    assert.doesNotMatch(instructions, COMPARATIVE, "instructions: comparative");
    assert.match(instructions, /Observed market research, not quotes, not medical advice/);
  });

  test(`${label}: every tool has annotations.title and boolean hints`, async () => {
    const { tools } = await listTools(options);
    for (const t of tools) {
      assert.ok(t.title && t.annotations?.title === t.title, `${t.name}: annotations.title`);
      assert.equal(t.annotations.readOnlyHint, true, `${t.name}: readOnlyHint`);
      assert.equal(t.annotations.destructiveHint, false, `${t.name}: destructiveHint`);
      assert.equal(t.annotations.openWorldHint, false, `${t.name}: openWorldHint`);
    }
  });
}

test('golden prompts: per tool 5 direct, 5 indirect, 3 negative, EN + ES; every expected tool exists', async () => {
  const { tools } = await listTools({});
  const names = tools.map((t) => t.name);
  const { prompts } = JSON.parse(readFileSync(new URL("../prompts/golden_prompts.json", import.meta.url), "utf8"));
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length, "unique ids");
  for (const p of prompts) {
    assert.ok(names.includes(p.for_tool), `${p.id}: unknown tool ${p.for_tool}`);
    assert.ok(["en", "es"].includes(p.lang), `${p.id}: lang`);
    assert.ok(p.prompt.length > 10, p.id);
    assert.doesNotMatch(p.prompt, FORBIDDEN, p.id);
    if (p.kind === "negative") assert.equal(p.expected_tool, "none", p.id);
    else assert.ok(names.includes(p.expected_tool), `${p.id}: unknown tool ${p.expected_tool}`);
  }
  for (const n of names) {
    for (const [kind, count] of [["direct", 5], ["indirect", 5], ["negative", 3]])
      assert.equal(prompts.filter((p) => p.for_tool === n && p.kind === kind).length, count, `${n}: ${count} ${kind}`);
    for (const lang of ["en", "es"]) assert.ok(prompts.some((p) => p.for_tool === n && p.lang === lang), `${n}: has ${lang}`);
  }
  // test bias: no golden prompt is copied word for word into a description
  for (const t of tools) for (const p of prompts) assert.ok(!t.description.includes(p.prompt), `${t.name} quotes ${p.id}`);
});
