#!/usr/bin/env node
/**
 * Source gate: fails if any number in the structuredContent of the treatment-plan
 * tools is not inside an object carrying `source_url` + (`period` | `effective_date`).
 * The only exemption is an object marked `basis: "user_input"` (the user's own quote).
 * Also fails if a cell flagged nominal_amounts_suspected exposes any dollar figure.
 * The nearest marked ancestor decides; the root may not carry a source_url.
 * Sweeps every state, every one of the 61 codes, and the golden plans; also checks size.
 * Lot C1: compare_states, us_dental_spending_stats, canada_dental_cost_by_province, cdcp_coverage_check;
 * under_review Canada rows must carry no number.
 * Caps table: fails if a cap_usd is set without source_url + a verbatim quote containing the number.
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
let numbers = 0, calls = 0, maxBytes = 0, nominal = 0;
function walk(o, where, ctx) {
  if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${where}[${i}]`, ctx));
  if (!o || typeof o !== "object") return;
  // Nominal-amount cells (managed-care encounters): no dollar figure may leave any tool.
  if (o.quality_flag === "nominal_amounts_suspected" && "lines" in o) { // claim-line cells only (atlas billing counts carry the flag too, no dollars)
    nominal++;
    if (o.status !== "amounts_not_reliable") errors.push(`${where}: nominal cell not marked amounts_not_reliable`);
    for (const [k, v] of Object.entries(o))
      if ((typeof v === "number" && !["lines", "n_providers"].includes(k)) || (v && typeof v === "object" && /\d/.test(JSON.stringify(v))))
        errors.push(`${where}.${k}: monetary figure on a nominal cell`);
  }
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
// Lot C1: compare_states (every procedure), MEPS, Canada (13 provinces/territories × 9 procedures), CDCP (incomes × provinces × procedures).
const PROCS = Object.keys(data("procedures")).sort();
for (const procedure of PROCS)
  for (let i = 0; i < STATES.length; i += 5) {
    const states = STATES.slice(i, i + 5);
    if (states.length >= 2) await check("compare_states", { procedure, states });
  }
await check("us_dental_spending_stats", {});
await check("us_dental_spending_stats", { lang: "es" });
const canada = data("canada");
const CA = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const CA_PROCS = Object.keys(canada.cdcp);
let withheld = 0;
const seenIssues = new Set();
async function caCheck(name, args) {
  const res = await client.callTool({ name, arguments: args });
  calls++;
  maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(res)));
  const sc = res.structuredContent;
  if (!sc) return errors.push(`${name} ${JSON.stringify(args)}: no structuredContent`);
  walk(sc, `${name}(${JSON.stringify(args)})`, null);
  (function scan(o) {
    if (Array.isArray(o)) return o.forEach(scan);
    if (!o || typeof o !== "object") return;
    if (o.data_quality === "under_review") {
      withheld++;
      seenIssues.add(o.issue);
      if (Object.values(o).some((v) => typeof v === "number")) errors.push(`${name} ${JSON.stringify(args)}: number on an under_review row`);
    }
    Object.values(o).forEach(scan);
  })(sc);
  return sc;
}
for (const province of CA) {
  await caCheck("canada_dental_cost_by_province", { province });
  for (const procedure of CA_PROCS) await caCheck("canada_dental_cost_by_province", { province, procedure, lang: "es" });
  for (const income of [0, 69999.99, 70000, 85000, 90000, 250000]) {
    await caCheck("cdcp_coverage_check", { adjusted_family_net_income_cad: income, province });
    for (const procedure of CA_PROCS) {
      const sc = await caCheck("cdcp_coverage_check", { adjusted_family_net_income_cad: income, province, procedure });
      const t = sc?.income_tier;
      const want = income < 70000 ? 0 : income < 80000 ? 40 : income < 90000 ? 60 : 100;
      if (t && t.copay_pct !== want) errors.push(`cdcp ${income}: copay ${t.copay_pct}, expected ${want}`);
    }
  }
}
for (const id of ["E-081", "E-086", "E-087", "E-094"]) if (!seenIssues.has(id)) errors.push(`Canada: issue ${id} never surfaced as under_review`);
console.log(`Canada: ${withheld} under_review rows seen (${[...seenIssues].sort().join(", ")}), none with a number`);
// Annual-cap table: one row = one proof. A figure needs a source_url and a verbatim quote containing it.
const caps = JSON.parse(fs.readFileSync(path.join(root, "data", "medicaid-adult-dental-caps-2026.json"), "utf8")).states;
const KINDS = ["annual_dollar_cap", "no_dollar_cap", "emergency_only", "no_adult_benefit", "not_verified"];
if (caps.length !== 51 || new Set(caps.map((c) => c.state)).size !== 51) errors.push(`caps table: ${caps.length} rows, expected 51 distinct states`);
for (const c of caps) {
  if (!KINDS.includes(c.cap_kind)) errors.push(`caps ${c.state}: unknown cap_kind ${c.cap_kind}`);
  if (c.cap_kind === "not_verified" && c.cap_usd != null) errors.push(`caps ${c.state}: not_verified with a figure`);
  if (c.cap_kind !== "not_verified" && !(c.source_url && c.quote && c.retrieved_at)) errors.push(`caps ${c.state}: ${c.cap_kind} without source_url + quote + retrieved_at`);
  if (c.cap_usd != null) {
    const forms = [String(c.cap_usd), c.cap_usd.toLocaleString("en-US")];
    if (typeof c.cap_usd !== "number" || !c.source_url || typeof c.quote !== "string" || !forms.some((f) => c.quote.includes(f)))
      errors.push(`caps ${c.state}: cap_usd=${c.cap_usd} not backed by source_url + a quote containing the number`);
    if (c.quote && c.quote.length > 300) errors.push(`caps ${c.state}: quote longer than 300 chars`);
  }
  const sc = (await client.callTool({ name: "medicaid_adult_dental_rules", arguments: { state: c.state } })).structuredContent;
  calls++;
  if ((sc.annual_cap.cap_usd ?? null) !== (c.cap_kind === "not_verified" ? null : c.cap_usd))
    errors.push(`caps ${c.state}: tool cap ${sc.annual_cap.cap_usd} != table ${c.cap_usd}`);
}
// Lot C2: insurance_out_of_pocket (every state x every procedure, with and without a missing parameter),
// medicare_dental_check (quotes <= 300 chars, sourced and dated), dental_program_changes (every state, periods).
for (const st of STATES) {
  const sc = await caCheck("insurance_out_of_pocket", {
    state: st,
    coverage: st < "M" ? "private" : "medicare_advantage",
    deductible_remaining_usd: 50,
    annual_max_remaining_usd: 1500,
    coinsurance_by_class: { a: 20, b: 50 },
    lines: PROCS.slice(0, 10).map((procedure, j) => ({ procedure, qty: 1 + (j % 2), ...(j % 3 === 0 ? { coinsurance_pct: 0 } : { class: j % 3 === 1 ? "a" : "b" }) })),
  });
  if (sc?.lines?.some((l) => l.status !== "ok")) errors.push(`insurance_out_of_pocket ${st}: a fully parameterised line was not computed`);
  const miss = await caCheck("insurance_out_of_pocket", { state: st, coverage: "private", lines: PROCS.slice(10).map((procedure) => ({ procedure, class: "unknown" })), no_annual_maximum: true });
  if (miss?.lines?.some((l) => l.status !== "parameter_missing" || l.estimate)) errors.push(`insurance_out_of_pocket ${st}: missing parameter computed anyway`);
  const dpc = await caCheck("dental_program_changes", { state: st, lang: st === "TX" ? "es" : "en" });
  if (dpc && !["ok", "not_yet_tracked", "none_tracked_in_period"].includes(dpc.status)) errors.push(`dental_program_changes ${st}: status ${dpc.status}`);
  if (dpc && /no change/i.test(JSON.stringify(dpc))) errors.push(`dental_program_changes ${st}: says "no change"`);
}
for (const args of [{}, { from: "2026-01-01" }, { from: "2026-07-01", to: "2026-09-30" }, { to: "2020-01-01" }]) await caCheck("dental_program_changes", args);
for (const coverage of ["original_medicare", "medicare_advantage", "not_sure"]) {
  const sc = await caCheck("medicare_dental_check", { coverage });
  (function scanQ(o) {
    if (Array.isArray(o)) return o.forEach(scanQ);
    if (!o || typeof o !== "object") return;
    if (typeof o.quote === "string" && (o.quote.length > 300 || !o.source_url || !o.retrieved_at)) errors.push(`medicare_dental_check: quote without source/date or > 300 chars`);
    Object.values(o).forEach(scanQ);
  })(sc);
  if (sc?.medicare_advantage?.status !== "not_yet_tracked") errors.push("medicare_dental_check: MA plans must be not_yet_tracked");
}
await client.close();

console.log(`${calls} calls, ${numbers} numbers checked, ${nominal} nominal cells checked amount-free, largest response ${maxBytes} bytes`);
if (nominal < 238) errors.push(`only ${nominal} nominal cells seen (expected >= 238): sweep incomplete`);
if (maxBytes >= 60_000) errors.push(`largest response ${maxBytes} bytes >= 60 KB`);
for (const e of errors.slice(0, 20)) console.log(`FAIL: ${e}`);
console.log(errors.length ? `\n${errors.length} unsourced number(s) or size issue(s).` : "\nEvery number is sourced and dated.");
process.exit(errors.length ? 1 : 0);
