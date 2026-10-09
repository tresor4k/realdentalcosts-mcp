#!/usr/bin/env node
/**
 * Parity with the published API v1: every figure the treatment-plan tools return
 * is compared with the site's public/api/v1 files (RDC_SITE_DIR, default ../dentist/web).
 * Dollar fields of nominal_amounts_suspected cells are withheld by design and excluded.
 * Prints the number of mismatches; exits 1 if any. Skips (exit 0) if the site is absent.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(process.env.RDC_SITE_DIR ?? path.join(root, "..", "dentist", "web"));
const api = path.join(site, "public", "api", "v1");
if (!fs.existsSync(api)) {
  console.log(`SKIP: API v1 not found at ${api}`);
  process.exit(0);
}
const rdc = await import(pathToFileURL(path.join(root, "dist", "lib", "rdc.js")));
const read = (...p) => JSON.parse(fs.readFileSync(path.join(api, ...p), "utf8"));

const diffs = [];
let compared = 0, excluded = 0;
const eq = (got, exp, where) => {
  compared++;
  if (got !== exp) diffs.push(`${where}: app=${JSON.stringify(got)} api=${JSON.stringify(exp)}`);
};
const F = ["period", "paid_per_line_wavg", "median_cell", "p25", "p75", "lines", "n_providers"];

for (const f of fs.readdirSync(path.join(api, "medicaid")).filter((f) => /^D\d{4}\.json$/.test(f))) {
  const j = read("medicaid", f);
  const nat = rdc.medicaidPaidByCode(j.code, undefined, "en");
  for (const k of F) eq(nat.national[k], j.national[k], `${j.code}/national.${k}`);
  for (const [y, v] of Object.entries(j.national.by_year)) for (const k of F.slice(1)) eq(nat.national.by_year[y][k], v[k], `${j.code}/national/${y}.${k}`);
  if (j.cash_benchmark)
    for (const k of ["national_low_usd", "national_avg_usd", "national_high_usd"]) eq(nat.cash_benchmark[k], j.cash_benchmark[k], `${j.code}/cash.${k}`);
  for (const st of rdc.STATE_CODES()) {
    const s = j.states.find((x) => x.code === st);
    const out = rdc.medicaidPaidByCode(j.code, st, "en");
    if (!s?.latest) {
      eq(out.cell.status, "no_source_at_this_level", `${j.code}/${st}/status`);
    } else if (s.quality_flag === "nominal_amounts_suspected") {
      // Deliberately withheld: dollar fields of nominal-amount cells are not served (excluded from parity).
      excluded++;
      eq(out.cell.status, "amounts_not_reliable", `${j.code}/${st}/status (nominal)`);
      for (const k of ["period", "lines", "n_providers"]) eq(out.cell[k], s.latest[k], `${j.code}/${st}.${k}`);
    } else {
      for (const k of F) eq(out.cell[k], s.latest[k], `${j.code}/${st}.${k}`);
      for (const [y, v] of Object.entries(s.by_year)) for (const k of F.slice(1)) eq(out.cell.by_year[y][k], v[k], `${j.code}/${st}/${y}.${k}`);
    }
    if (s?.official_fee) {
      for (const k of ["fee_usd", "effective_date", "source_url"]) eq(out.official_fee[k], s.official_fee[k], `${j.code}/${st}/fee.${k}`);
      if (s.official_fee.fee_alt_usd != null) eq(out.official_fee.fee_alt_usd, s.official_fee.fee_alt_usd, `${j.code}/${st}/fee.fee_alt_usd`);
    } else eq(out.official_fee.status, "no_source_at_this_level", `${j.code}/${st}/fee.status`);
  }
}

for (const f of fs.readdirSync(path.join(api, "state")).filter((f) => f.endsWith(".json"))) {
  const j = read("state", f);
  const out = rdc.benchmarkTreatmentPlan(j.code, j.procedures.map((p) => ({ procedure: p.id })), "none", "en");
  j.procedures.forEach((p, i) => {
    const band = out.lines[i].cash_band;
    if (p.basis === "national") {
      const n = read("procedure", `${p.slug}.json`).national;
      for (const k of ["low_usd", "avg_usd", "high_usd"]) {
        eq(band.next_level[k], n[k], `${j.code}/${p.id}/national.${k}`);
        eq(p[k], n[k], `${j.code}/${p.id} state API value equals national (basis national).${k}`);
      }
    } else for (const k of ["low_usd", "avg_usd", "high_usd", "basis"]) eq(band[k], p[k], `${j.code}/${p.id}.${k}`);
    eq(band.period ?? band.next_level?.period, p.provenance.period, `${j.code}/${p.id}.period`);
  });
  eq(out.medicaid_adult_rule.level.value, j.medicaid.adult_dental_coverage_level, `${j.code}/medicaid level`);
}

console.log(`${compared} values compared with API v1 (${api}), ${diffs.length} mismatch(es); ${excluded} nominal-amount cells: dollar fields deliberately withheld, not compared`);
for (const d of diffs.slice(0, 20)) console.log(`DIFF: ${d}`);
process.exit(diffs.length ? 1 : 0);
