#!/usr/bin/env node
/**
 * Source gate: fails if any number in the structuredContent of the treatment-plan
 * tools is not inside an object carrying `source_url` + (`period` | `effective_date`).
 * The only exemption is an object marked `basis: "user_input"` (the user's own quote).
 * The nearest marked ancestor decides; the root may not carry a source_url.
 * Sweeps every state, every one of the 61 codes, and the golden plans; also checks size.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = (f) => JSON.parse(fs.readFileSync(path.join(root, "dist", "data", "rdc", `${f}.json`), "utf8"));
const STATES = Object.keys(data("states")).sort();
const CODES = Object.keys(data("medicaid").codes).sort();
const { createServer } = await import(pathToFileURL(path.join(root, "dist", "tools.js")));

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ appsSdk: true }).connect(a);
const client = new Client({ name: "sources", version: "0.0.0" });
await client.connect(b);

const errors = [];
let numbers = 0, calls = 0, maxBytes = 0;
function walk(o, where, ctx) {
  if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${where}[${i}]`, ctx));
  if (!o || typeof o !== "object") return;
  const here = typeof o.source_url === "string" ? { src: true, dated: o.period != null || o.effective_date != null, at: where }
    : o.basis === "user_input" ? { user: true } : ctx;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number") {
      numbers++;
      if (!here) errors.push(`${where}.${k}=${v}: no source_url in any enclosing object`);
      else if (here.src && !here.dated) errors.push(`${where}.${k}=${v}: source at ${here.at} has no period/effective_date`);
    } else walk(v, `${where}.${k}`, here);
  }
}
async function check(name, args) {
  const res = await client.callTool({ name, arguments: args });
  calls++;
  maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(res)));
  const sc = res.structuredContent;
  if (!sc) return errors.push(`${name} ${JSON.stringify(args)}: no structuredContent`);
  if (sc.source_url) errors.push(`${name}: source_url at root would whitelist everything`);
  walk(sc, `${name}(${args.state ?? ""}${args.code ? " " + args.code : ""})`, null);
}

for (const st of STATES) {
  await check("medicaid_adult_dental_rules", { state: st });
  await check("low_cost_dental_options", { state: st });
  for (let i = 0; i < CODES.length; i += 10)
    await check("benchmark_treatment_plan", {
      state: st,
      coverage: "medicaid_adult",
      lines: CODES.slice(i, i + 10).map((code, j) => ({ code, qty: 1 + (j % 3), quoted_usd: 100 + j * 37 })),
    });
  await check("benchmark_treatment_plan", { state: st, lines: ["implant", "whitening", "veneer", "dentures", "exam"].map((procedure) => ({ procedure, quoted_usd: 999 })) });
}
for (const code of CODES) {
  await check("medicaid_paid_by_code", { code });
  for (const st of STATES) await check("medicaid_paid_by_code", { code, state: st });
}
await check("low_cost_dental_options", { state: "OH", county: "Franklin" });
await check("low_cost_dental_options", { state: "OH", county: "Nowhere" });
await check("benchmark_treatment_plan", { state: "AZ", lines: [{ code: "D2740", quoted_usd: 1450 }, { code: "D3330", quoted_usd: 1350 }, { code: "D4341", qty: 4, quoted_usd: 1100 }, { code: "D0367", quoted_usd: 350 }] });
await client.close();

console.log(`${calls} calls, ${numbers} numbers checked, largest response ${maxBytes} bytes`);
if (maxBytes >= 60_000) errors.push(`largest response ${maxBytes} bytes >= 60 KB`);
for (const e of errors.slice(0, 20)) console.log(`FAIL: ${e}`);
console.log(errors.length ? `\n${errors.length} unsourced number(s) or size issue(s).` : "\nEvery number is sourced and dated.");
process.exit(errors.length ? 1 : 0);
