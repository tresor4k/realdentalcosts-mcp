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

// 5. Lot C2: insurance_out_of_pocket — the user's own figures x the state cash band, formula written out
{
  const crown = STATES.OH.procedures.crown;
  const sc = await call("insurance_out_of_pocket", {
    state: "OH",
    coverage: "private",
    deductible_remaining_usd: 50,
    annual_max_remaining_usd: 1000,
    coinsurance_by_class: { major: 50 },
    lines: [{ procedure: "crown", class: "major" }, { procedure: "rootcanal" }],
  });
  const [l1, l2] = sc.lines;
  const exp = (g) => { const plan = Math.min((g - 50) * 0.5, 1000); return Math.round((g - plan) * 100) / 100; };
  assert(l1.status === "ok" && l1.cash_band.avg_usd === crown.avg_usd, `OH crown band = API (${crown.avg_usd})`);
  assert(l1.estimate.at_avg.you_pay_usd === exp(crown.avg_usd) && l1.estimate.at_low.you_pay_usd === exp(crown.low_usd), `OH crown: you pay = gross - min((gross - 50) x 0.5, 1000) (${exp(crown.avg_usd)})`);
  assert(l1.estimate.badge === "estimated" && /min\(/.test(sc.formula), "estimate badged estimated, formula written");
  assert(l2.status === "parameter_missing" && !l2.estimate && l2.missing.some((m) => /coinsurance/.test(m)), "line without coinsurance → parameter_missing, not computed");
  assert(sc.totals.lines_computed === 1, "totals over computed lines only");
  const ma = await call("insurance_out_of_pocket", {
    state: "FL",
    coverage: "medicare_advantage",
    deductible_remaining_usd: 0,
    annual_max_remaining_usd: 500,
    lines: [{ procedure: "implant", coinsurance_pct: 50 }, { procedure: "crown", coinsurance_pct: 50 }],
  });
  assert(ma.lines[0].estimate.at_avg.plan_pays_usd === 500 && ma.lines[1].estimate.at_avg.plan_pays_usd === 0, "annual maximum carried from line to line (500 then 0)");
  assert(ma.lines[1].estimate.at_avg.annual_maximum_reached === true && /Evidence of Coverage/.test(ma.coverage.note), "MA: maximum reached flagged, plan document cited");
  const none = await call("insurance_out_of_pocket", { state: "TX", coverage: "private", lines: [{ procedure: "filling", coinsurance_pct: 20 }] });
  assert(none.lines[0].status === "parameter_missing" && none.totals.status === "not_computed" && numbersIn(none.totals) === 0, "no deductible / maximum given → nothing computed, no default assumed");
}

// 6. Lot C2: medicare_dental_check — statutory exclusion, verbatim quotes, MA plans not yet tracked
{
  const sc = await call("medicare_dental_check", { coverage: "not_sure" });
  const om = sc.original_medicare;
  assert(/replacement of teeth/.test(om.statute.quote) && /411\.15/.test(om.regulation.source) && om.medicare_gov.length === 3, "statute + regulation + medicare.gov quotes");
  assert([om.statute, om.regulation, ...om.medicare_gov].every((q) => q.quote.length <= 300 && q.source_url.startsWith("https://") && q.retrieved_at), "quotes <= 300 chars with URL + retrieval date");
  assert(sc.medicare_advantage.status === "not_yet_tracked" && sc.medicare_advantage.next_step.tool === "insurance_out_of_pocket", "MA plans not yet tracked → insurance_out_of_pocket");
  assert(!/":-?\d/.test(JSON.stringify(sc)), "no numeric value at all");
}

// 7. Lot C2: dental_program_changes — dated, adopted changes; untracked states never read as "no change"
{
  const RULES = data("rules");
  const PROG = data("programs");
  const tx = await call("dental_program_changes", { state: "TX" });
  const rate = tx.changes.find((c) => c.kind === "medicaid_fee_schedule_rate_change");
  assert(rate && rate.effective_date === PROG.tx_rate_change.effective_date && rate.rows.length === PROG.tx_rate_change.rows.length, `TX rate change ${PROG.tx_rate_change.effective_date}, ${PROG.tx_rate_change.rows.length} codes`);
  const odd = PROG.tx_rate_change.rows.filter((r) => !/^\d{1,2}-(\d|1\d|20)$/.test(r.age_range)).length;
  const flagged = rate.rows.filter((r) => r.age_range_status);
  assert(odd > 0 && flagged.length === odd && flagged.every((r) => r.age_range === null), `TX: ${odd} rows with an implausible age range in the source extract are flagged, not passed off as parsed`);
  const co = await call("dental_program_changes", { state: "CO" });
  const cap = co.changes.find((c) => c.kind === "adult_dental_cap_effective");
  assert(cap && cap.effective_date === "2026-07-01" && cap.cap_usd === RULES.CO.cap.cap_usd && cap.quote === RULES.CO.cap.quote, `CO cap effective 2026-07-01 = caps table (${RULES.CO.cap.cap_usd})`);
  const wv = await call("dental_program_changes", { state: "WV", to: "2025-01-01" });
  assert(wv.changes.some((c) => c.kind === "adult_dental_cap_effective" && c.effective_date === "2024-07-01"), "WV cap effective 2024-07-01, period filter applied");
  const untracked = Object.keys(RULES).find((s) => s !== "TX" && !RULES[s].schedule?.effective_date && !/effective|on and after|and on/i.test(RULES[s].cap?.period ?? ""));
  const u = await call("dental_program_changes", { state: untracked });
  assert(u.status === "not_yet_tracked" && u.changes.length === 0 && !/no change/i.test(JSON.stringify(u)), `${untracked}: not_yet_tracked, never "no change"`);
  const q3 = await call("dental_program_changes", { from: "2026-07-01", to: "2026-09-30" });
  assert(q3.changes.every((c) => c.effective_date >= "2026-07-01" && c.effective_date <= "2026-09-30") && q3.changes.some((c) => c.state === "TX") && q3.states_not_yet_tracked.includes(untracked), "period filter across states + list of untracked states");
}

// 8. Lot 1 (13/10): CDT bundles, city average, quoted_usd on dental_cost_by_state
{
  const ref = STATES.OR.procedures.implant;
  const sc = await call("benchmark_treatment_plan", {
    state: "OR",
    city: "Portland",
    lines: [{ code: "D6010", quoted_usd: 2926 }, { code: "D6057", quoted_usd: 1331 }, { code: "D6058", quoted_usd: 2231 }],
  });
  const b = sc.bundles?.find((x) => x.bundle === "implant");
  assert(b?.status === "complete" && b.quote.bundle_total_usd === 2926 + 1331 + 2231, "OR implant bundle total = sum of the 3 lines");
  assert(b.cash_band.low_usd === ref.low_usd && b.cash_band.avg_usd === ref.avg_usd && b.cash_band.high_usd === ref.high_usd, `OR implant band = ${ref.low_usd}/${ref.avg_usd}/${ref.high_usd}`);
  const exp = 6488 > ref.high_usd ? "above_band" : 6488 < ref.low_usd ? "below_band" : "within_band";
  assert(b.verdict === exp && exp === "above_band", `OR implant bundle 6488 → ${exp}`);
  assert(sc.totals.above_band.includes("bundle:implant") && sc.totals.not_covered.length === 0, "bundle verdict in totals, bundle lines not reported as not_covered");
  assert(sc.lines.every((l) => l.status === "bundle_line") && !/":-?\d/.test(JSON.stringify(sc.lines.map(({ input, ...r }) => r))), "bundle lines carry no per-line figure");
  const city = JSON.parse(fs.readFileSync(path.join(root, "dist", "data", "cities.json"), "utf8")).states.find((s) => s.code === "OR").cities.find((c) => c.name === "Portland");
  assert(sc.city_reference.status === "ok" && sc.city_reference.avg_usd === city.costs.Implants.avg && sc.city_reference.source_url, `Portland OR city implant average = ${city.costs.Implants.avg}`);
  const nocity = await call("benchmark_treatment_plan", { state: "OR", city: "Nowhereville", lines: [{ code: "D6010" }] });
  assert(nocity.city_reference.status === "no_source_at_this_level" && !("avg_usd" in nocity.city_reference), "unknown city → no figure");

  const solo = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D6010", quoted_usd: 2926 }] });
  const s = solo.bundles.find((x) => x.bundle === "implant");
  assert(s.status === "partial_quote" && s.verdict === "none" && s.missing.length === 2 && /D6010/.test(s.band_includes), "D6010 alone → partial_quote with what the band includes");
  assert(!solo.totals.above_band.length && !solo.totals.within_band.length, "partial quote → no verdict in totals");

  const arch = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D5110", quoted_usd: 1500 }] });
  const d = arch.bundles.find((x) => x.bundle === "dentures");
  assert(d.status === "no_per_arch_band" && d.verdict === "none" && /per-arch band/.test(d.reason), "D5110 alone → no per-arch band");
  const part = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D5213", quoted_usd: 1500 }] });
  assert(part.bundles.find((x) => x.bundle === "dentures").status === "no_per_arch_band", "partial denture D5213 → no per-arch band");
  const full = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D5110", quoted_usd: 1000 }, { code: "D5120", quoted_usd: 1000 }] });
  const f = full.bundles.find((x) => x.bundle === "dentures");
  const dref = STATES.OR.procedures.dentures;
  const dexp = 2000 > dref.high_usd ? "above_band" : 2000 < dref.low_usd ? "below_band" : "within_band";
  assert(f.status === "complete" && f.quote.bundle_total_usd === 2000 && f.verdict === dexp, `OR D5110 + D5120 = 2000 → ${dexp}`);

  const ven = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D2962", qty: 2, quoted_usd: 3000 }] });
  const v = ven.bundles.find((x) => x.bundle === "veneer");
  assert(v.status === "complete" && v.quote.per_unit_usd === 1500 && v.cash_band.procedure_id === "veneer", "D2962 x2 → per-tooth veneer comparison");
  const a4 = await call("benchmark_treatment_plan", { state: "OR", lines: [{ code: "D6114", quoted_usd: 20000 }, { code: "D6010", qty: 4, quoted_usd: 8000 }] });
  const a = a4.bundles.find((x) => x.bundle === "allon4");
  assert(a.status === "complete" && a.quote.bundle_total_usd === 28000 && a.quote.units === 1 && !a4.bundles.some((x) => x.bundle === "implant"), "D6114 + D6010 x4 → one All-on-4 arch, no single-implant bundle");

  const q = await call("dental_cost_by_state", { procedure: "implant", state: "OR", quoted_usd: 6488 });
  assert(q.quotePosition?.verdict === "above_band" && q.quotePosition.basis === "user_input", "dental_cost_by_state quoted_usd 6488 OR implant → above_band");
  const noq = await call("dental_cost_by_state", { procedure: "implant", state: "OR" });
  assert(!("quotePosition" in noq), "no quoted_usd → no quotePosition");
}

await client.close();
console.log(failures ? `\n${failures} golden check(s) failed.` : "\nAll golden checks passed.");
process.exit(failures ? 1 : 0);
