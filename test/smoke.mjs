#!/usr/bin/env node
/**
 * Offline smoke test for realdentalcosts-mcp.
 * Spawns the built stdio server, drives it through the MCP SDK client,
 * and checks tool responses against values loaded independently from the
 * same source data files (never hand-typed expectations).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// Independently load the same compiled data the server uses, to derive
// expected values (no hand-coded numbers).
const { COMPARE_PRICES } = await import(pathToFileURL(path.join(root, "dist", "lib", "compare-data.js")));
const { nationalTriple } = await import(pathToFileURL(path.join(root, "dist", "lib", "pricing.js")));
const citiesData = JSON.parse(fs.readFileSync(path.join(root, "dist", "data", "cities.json"), "utf8"));

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`OK: ${msg}`);
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
});

const client = new Client({ name: "smoke-test-client", version: "0.1.0" });
await client.connect(transport);

// --- tools/list ---
const toolsList = await client.listTools();
assert(toolsList.tools.length === 4, `tools/list returns 4 tools (got ${toolsList.tools.length})`);
const toolNames = toolsList.tools.map((t) => t.name).sort();
assert(
  JSON.stringify(toolNames) ===
    JSON.stringify([
      "dental_cost_by_city",
      "dental_cost_by_state",
      "dental_national_average",
      "out_of_pocket_estimate",
    ].sort()),
  `tool names match expected set (got ${toolNames.join(", ")})`,
);

function textOf(result) {
  const first = result.content?.[0];
  if (!first || first.type !== "text") throw new Error("expected text content");
  return JSON.parse(first.text);
}

// --- dental_cost_by_state: implant / CA ---
{
  const res = await client.callTool({
    name: "dental_cost_by_state",
    arguments: { procedure: "implant", state: "CA" },
  });
  const data = textOf(res);
  const [low, avg, high] = COMPARE_PRICES.CA.implant;
  assert(
    data.cashPrice.low === low && data.cashPrice.avg === avg && data.cashPrice.high === high,
    `dental_cost_by_state(implant, CA) matches COMPARE_PRICES.CA.implant [${low},${avg},${high}]`,
  );
  assert(!res.isError, "dental_cost_by_state(implant, CA) is not an error");
}

// --- dental_national_average: implant ---
{
  const res = await client.callTool({
    name: "dental_national_average",
    arguments: { procedure: "implant" },
  });
  const data = textOf(res);
  const [low, avg, high] = nationalTriple("implant");
  assert(
    data.nationalAverage.low === Math.round(low) &&
      data.nationalAverage.avg === Math.round(avg) &&
      data.nationalAverage.high === Math.round(high),
    `dental_national_average(implant) matches nationalTriple('implant')`,
  );
}

// --- dental_cost_by_city: first CA city in the dataset ---
{
  const caState = citiesData.states.find((s) => s.code === "CA");
  assert(!!caState && caState.cities.length > 0, "dataset has at least one CA city");
  const firstCity = caState.cities[0];
  const res = await client.callTool({
    name: "dental_cost_by_city",
    arguments: { city: firstCity.name, state: "CA" },
  });
  const data = textOf(res);
  assert(!res.isError, `dental_cost_by_city(${firstCity.name}, CA) is not an error`);
  assert(
    data.city === firstCity.name,
    `dental_cost_by_city returns city name "${firstCity.name}"`,
  );
  if (firstCity.costs.Implants) {
    assert(
      data.costs.Implants.cityAvg === firstCity.costs.Implants.avg,
      `dental_cost_by_city Implants.cityAvg matches source (${firstCity.costs.Implants.avg})`,
    );
  }
}

// --- lang: es ---
{
  const res = await client.callTool({
    name: "dental_cost_by_state",
    arguments: { procedure: "implant", state: "AL", lang: "es" },
  });
  const data = textOf(res);
  assert(
    data.procedure.label === "Implante dental (completo)",
    `lang=es returns Spanish procedure label (got "${data.procedure.label}")`,
  );
  assert(
    data.disclaimer.toLowerCase().includes("investigación"),
    "lang=es returns Spanish disclaimer",
  );
}

// --- unknown city error path ---
{
  const res = await client.callTool({
    name: "dental_cost_by_city",
    arguments: { city: "Nowheresville12345" },
  });
  assert(res.isError === true, "unknown city returns isError=true");
}

await client.close();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll smoke checks passed.");
  process.exit(0);
}
