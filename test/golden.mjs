#!/usr/bin/env node
/**
 * Golden scenarios for the treatment-plan tools (in-memory MCP client, Apps SDK mode).
 * Expected figures are read from the synced data (dist/data/rdc), never hand-typed;
 * the scenarios pin the behaviour (verdicts, statuses, scopes, absences).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = (f) => JSON.parse(fs.readFileSync(path.join(root, "dist", "data", "rdc", `${f}.json`), "utf8"));
const STATES = data("states");
const MED = data("medicaid").codes;
const { createServer } = await import(pathToFileURL(path.join(root, "dist", "tools.js")));

const [a, b] = InMemoryTransport.createLinkedPair();
await createServer({ appsSdk: true }).connect(a);
const client = new Client({ name: "golden", version: "0.0.0" });
await client.connect(b);

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? "OK" : "FAIL"}: ${msg}`);
};
const FORBIDDEN = /1Dental|savings plan|subscribe|affordability|Medicaid price/i;
async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const raw = JSON.stringify(res);
  assert(!res.isError, `${name} ${JSON.stringify(args).slice(0, 80)} is not an error`);
  assert(Buffer.byteLength(raw) < 60_000, `${name} response < 60 KB (${Buffer.byteLength(raw)} bytes)`);
  assert(!FORBIDDEN.test(raw), `${name} response has no forbidden wording`);
  return res.structuredContent;
}
const numbersIn = (o) => JSON.stringify(o).match(/:-?\d/g)?.length ?? 0;

// 1. Implant quoted $4,800 in Columbus, OH (state band)
{
  const sc = await call("benchmark_treatment_plan", { state: "OH", lines: [{ procedure: "implant", quoted_usd: 4800 }] });
  const ref = STATES.OH.procedures.implant;
  const band = sc.lines[0].cash_band;
  assert(band.low_usd === ref.low_usd && band.avg_usd === ref.avg_usd && band.high_usd === ref.high_usd, `OH implant band = ${ref.low_usd}/${ref.avg_usd}/${ref.high_usd}`);
  const exp = 4800 > ref.high_usd ? "above_high_by_pct" : 4800 < ref.low_usd ? "below_low_by_pct" : "within_band";
  assert(band.position.verdict === exp, `OH implant $4,800 verdict = ${exp}`);
  assert(band.badges.avg_usd === "observed" && band.badges.low_usd === "estimated", "observed average, estimated band badges");
  assert(sc.lines[0].medicaid_paid.status === "code_required", "procedure line asks for a code before T-MSIS figures");
  assert(sc.source_notes.length > 0 && sc.source_notes.every((n) => n.url && n.date), "source notes carry URL + date");
}

// 2. Texas dentures, adult Medicaid coverage
{
  const sc = await call("benchmark_treatment_plan", {
    state: "TX",
    coverage: "medicaid_adult",
    lines: [{ procedure: "dentures" }, { code: "D5110" }, { code: "D5120" }],
  });
  assert(sc.medicaid_adult_rule.level.value === STATES.TX.medicaid.adult_dental_coverage_level, `TX adult level = ${STATES.TX.medicaid.adult_dental_coverage_level}`);
  const d5110 = sc.lines[1];
  const cell = MED.D5110.states.TX.latest;
  assert(d5110.medicaid_paid.median_cell === cell.median_cell && d5110.medicaid_paid.p25 === cell.p25 && d5110.medicaid_paid.p75 === cell.p75, "TX D5110 T-MSIS p25/median/p75 = API");
  assert(d5110.medicaid_paid.label === "paid per claim line (T-MSIS)", "T-MSIS label imposed");
  assert(d5110.fee_schedule.schedule_scope === "children_only", "TX fee schedule flagged children_only");
  assert(d5110.cash_band.position.verdict === "no_quote", "no quote → no verdict");
  assert(sc.lines[0].cash_band.avg_usd === STATES.TX.procedures.dentures.avg_usd, "TX dentures band = API");
  assert(/children_only/.test(sc.coverage.note), "coverage note warns about children-only schedules");
}

// 3. Phoenix, AZ: D2740 1450 / D3330 1350 / D4341×4 1100 / D0367 350
{
  const sc = await call("benchmark_treatment_plan", {
    state: "AZ",
    lines: [
      { code: "D2740", quoted_usd: 1450 },
      { code: "D3330", quoted_usd: 1350 },
      { code: "D4341", qty: 4, quoted_usd: 1100 },
      { code: "D0367", quoted_usd: 350 },
    ],
  });
  const [crown, rc, srp, cbct] = sc.lines;
  assert(crown.cash_band.avg_usd === STATES.AZ.procedures.crown.avg_usd, "AZ D2740 → crown band");
  assert(crown.medicaid_paid.quality_flag === "nominal_amounts_suspected", "AZ cells flagged nominal_amounts_suspected");
  for (const l of [crown, rc, srp])
    assert(
      l.medicaid_paid.status === "amounts_not_reliable" && ["p25", "median_cell", "p75", "paid_per_line_wavg"].every((k) => l.medicaid_paid[k] === undefined),
      `AZ ${l.input.code}: Medicaid paid withheld (amounts_not_reliable, no dollar figure)`,
    );
  assert(srp.medicaid_paid.lines === MED.D4341.states.AZ.latest.lines, "AZ D4341 keeps line count only");
  assert(crown.fee_schedule.fee_usd === MED.D2740.states.AZ.official_fee.fee_usd, "AZ D2740 official fee = API");
  assert(rc.cash_band.basis === "estimated" && rc.cash_band.badges.avg_usd === "estimated", "D3330 root-canal band badged estimated");
  assert(srp.cash_band.position.quoted_per_unit_usd === 275, "D4341×4 $1,100 → $275 per quadrant");
  assert(cbct.status === "not_covered" && numbersIn({ ...cbct, input: undefined }) === 0, "D0367 (outside the 61 codes) → not_covered, 0 figure");
  assert(sc.totals.quoted_total_usd === 4250 && sc.totals.not_covered.includes("D0367"), "totals = user quotes");
}

// 3b. Michigan: non-NPI identifiers → amounts kept with a caveat
{
  const code = Object.keys(MED).find((c) => MED[c].states.MI?.quality_flag === "non_npi_identifiers" && MED[c].states.MI.latest);
  const sc = await call("medicaid_paid_by_code", { code, state: "MI" });
  assert(sc.cell.status === "ok" && typeof sc.cell.median_cell === "number" && /not NPIs/.test(sc.cell.caveat ?? ""), `MI ${code}: amounts kept + non-NPI caveat`);
}

// 4. Missing cells → no_source_at_this_level + next level, never a number
{
  const missing = Object.keys(STATES).find((st) => !MED.D2740.states[st]);
  const sc = await call("medicaid_paid_by_code", { code: "D2740", state: missing });
  assert(sc.cell.status === "no_source_at_this_level" && sc.cell.next_level.geo === "national", `D2740 ${missing}: no state cell → national next level`);
  assert(sc.cell.median_cell === undefined && sc.official_fee.status === "no_source_at_this_level", "no state figure is invented");
  const ma = await call("medicaid_adult_dental_rules", { state: "MA" });
  assert(ma.annual_cap.status === "ok" && ma.annual_cap.cap_usd === 1750 && ma.annual_cap.quote.includes("$1,750"), "MA cap $1,750 with its verbatim quote");
  const ca = await call("medicaid_adult_dental_rules", { state: "CA" });
  assert(ca.annual_cap.status === "not_verified" && ca.annual_cap.cap_usd === undefined, "CA cap not verified → no figure");
  const opt = await call("low_cost_dental_options", { state: "OH", county: "Nowhere" });
  assert(opt.county.status === "no_source_at_this_level" && opt.county.next_level.geo === "state", "unknown county → state level");
  const ok = await call("low_cost_dental_options", { state: "OH", county: "Franklin" });
  assert(ok.county.status === "ok" && ok.county.fips, `Franklin County, OH found (${ok.county.fips})`);
}

await client.close();
console.log(failures ? `\n${failures} golden check(s) failed.` : "\nAll golden checks passed.");
process.exit(failures ? 1 : 0);
