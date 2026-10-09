#!/usr/bin/env node
/**
 * Copies and reduces the PUBLISHED Real Dental Costs sources into src/data/rdc/
 * (the app reads nothing else). Values are copied verbatim — no recomputation —
 * so every number served by the app equals the open API v1.
 *
 * Usage: node scripts/sync-data.mjs [siteDir]   (default ../dentist/web, or RDC_SITE_DIR)
 * Writes src/data/rdc/{medicaid,states,procedures,rules,options,chains}.json and
 * manifest.json (sha256 of every input and output file + sync date).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const site = path.resolve(process.argv[2] ?? process.env.RDC_SITE_DIR ?? path.join(root, "..", "dentist", "web"));
const out = path.join(root, "src", "data", "rdc");
const SITE = "https://realdentalcosts.com";
const inputs = [];

function read(rel) {
  const file = path.join(site, rel);
  const buf = fs.readFileSync(file);
  inputs.push({ file: rel.replaceAll("\\", "/"), sha256: sha(buf), bytes: buf.length });
  return buf.toString("utf8");
}
const json = (rel) => JSON.parse(read(rel));
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function csv(text) {
  const rows = [];
  for (const line of text.trim().split(/\r?\n/)) {
    const v = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === "," && !q) { v.push(cur); cur = ""; }
      else cur += ch;
    }
    v.push(cur);
    rows.push(v);
  }
  const [h, ...body] = rows;
  return body.map((v) => Object.fromEntries(h.map((k, i) => [k, v[i] ?? ""])));
}
const num = (s) => (s === "" || s == null ? null : Number(s));
const pick = (o, keys) => o == null ? null : Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

// ---------------------------------------------------------------------------
// Medicaid paid per claim line (API v1 /medicaid/{code}.json) — 61 codes
// ---------------------------------------------------------------------------
const MED = "public/api/v1/medicaid";
const YEAR_KEYS = ["paid_per_line_wavg", "median_cell", "p25", "p75", "lines", "n_providers"];
const slimYears = (by) => Object.fromEntries(Object.entries(by ?? {}).map(([y, v]) => [y, pick(v, YEAR_KEYS)]));
const codeFiles = fs.readdirSync(path.join(site, MED)).filter((f) => /^D\d{4}\.json$/.test(f)).sort();
let medMeta = null;
const medicaid = {};
for (const f of codeFiles) {
  const j = json(`${MED}/${f}`);
  medMeta ??= j.meta;
  medicaid[j.code] = {
    label: j.label,
    provenance: pick(j.provenance, ["source", "source_url", "period", "period_end", "updated", "modeled"]),
    national: { ...pick(j.national, ["period", ...YEAR_KEYS]), by_year: slimYears(j.national.by_year) },
    cash_benchmark: j.cash_benchmark
      ? pick(j.cash_benchmark, ["procedure_id", "procedure_slug", "label", "national_low_usd", "national_avg_usd", "national_high_usd", "basis", "url"])
      : null,
    states: Object.fromEntries(
      j.states.map((s) => [
        s.code,
        {
          quality_flag: s.quality_flag,
          quality_evidence: s.quality_evidence,
          confidence: s.confidence,
          latest: pick(s.latest, ["period", ...YEAR_KEYS]),
          by_year: slimYears(s.by_year),
          official_fee: s.official_fee
            ? pick(s.official_fee, ["fee_usd", "fee_alt_usd", "fee_alt_label", "effective_date", "ada_index_as_of", "source_url", "column_note"])
            : null,
        },
      ]),
    ),
  };
}
const medicaidOut = {
  meta: {
    ...pick(medMeta, ["generated_at", "source", "source_url", "dataset_doi", "suppression", "measure", "period_note", "labels_note"]),
    api_url_template: `${SITE}/api/v1/medicaid/{code}.json`,
  },
  codes: medicaid,
};

// ---------------------------------------------------------------------------
// State cash bands (API v1 /state/{st}.json) + national bands (/procedure/{slug}.json)
// affordability_score is deliberately NOT copied (owner decision pending).
// ---------------------------------------------------------------------------
const PROV_KEYS = ["source", "source_url", "period", "period_end", "updated", "modeled", "confidence", "confidence_note"];
const stateFiles = fs.readdirSync(path.join(site, "public/api/v1/state")).filter((f) => f.endsWith(".json")).sort();
const states = {};
for (const f of stateFiles) {
  const j = json(`public/api/v1/state/${f}`);
  states[j.code] = {
    name: j.state,
    generated_at: j.meta.generated_at,
    medicaid: pick(j.medicaid, ["pct_dentists_accepting", "adult_dental_coverage_level", "source", "doi"]),
    procedures: Object.fromEntries(
      j.procedures.map((p) => [
        p.id,
        { ...pick(p, ["slug", "label", "category", "basis", "low_usd", "avg_usd", "high_usd"]), provenance: pick(p.provenance, PROV_KEYS) },
      ]),
    ),
  };
}
const procFiles = fs.readdirSync(path.join(site, "public/api/v1/procedure")).filter((f) => f.endsWith(".json")).sort();
const procedures = {};
for (const f of procFiles) {
  const j = json(`public/api/v1/procedure/${f}`);
  procedures[j.id] = {
    ...pick(j, ["slug", "label", "category", "basis", "basis_note"]),
    national: pick(j.national, ["low_usd", "avg_usd", "high_usd", "source"]),
    provenance: pick(j.provenance, PROV_KEYS),
  };
}

// ---------------------------------------------------------------------------
// Adult Medicaid rules: caps (acceptance CSV), ortho/implant policy,
// fee-schedule scope, billing dentists (atlas), program summaries.
// ---------------------------------------------------------------------------
const ACC = "public/data/us-dental-insurance-acceptance-by-state-2026.csv";
const acc = Object.fromEntries(csv(read(ACC)).map((r) => [r.code, r]));
const policy = json("data/medicaid-ortho-implant-policy.json");
const free = json("data/free-dental-programs-by-state.json");
const FEE = "data/medicaid-fee-schedules";
const feeFiles = fs.readdirSync(path.join(site, FEE)).filter((f) => /^[a-z]{2}\.json$/.test(f)).sort();
const schedules = {};
for (const f of feeFiles) {
  const j = json(`${FEE}/${f}`);
  schedules[j.code] = {
    source_url: j.source_url,
    effective_date: j.effective_date ?? null,
    // Only "children" is ever set upstream; absence means "not flagged children-only", never "all ages".
    schedule_scope: j.schedule_scope === "children" ? "children_only" : "not_flagged_children_only",
    column_note: j.column_note ?? null,
  };
}
const ATLAS_CSV = "public/data/us-dental-deserts-atlas-2026.csv";
read(ATLAS_CSV); // hashed for the manifest; the per-state atlas JSON below is the same build
const rules = {};
const options = {};
const issues = [];
for (const code of Object.keys(states).sort()) {
  const a = acc[code];
  const pol = policy.states.find((s) => s.code === code);
  const fr = free.states.find((s) => s.code === code);
  const atlas = json(`public/data/atlas/${code}.json`);
  const sl = atlas.state_layer;
  if (a && a.medicaid_adult_dental_level !== states[code].medicaid.adult_dental_coverage_level)
    issues.push(`${code}: acceptance CSV level=${a.medicaid_adult_dental_level} vs API v1 state=${states[code].medicaid.adult_dental_coverage_level}`);
  const slimPol = (p) =>
    p && pick(p, ["status", "under21", "adult_21plus", "note", "quote", "source_url", "source_title", "source_date"]);
  rules[code] = {
    cap_usd: a ? num(a.medicaid_adult_dental_cap_usd) : null,
    csv_level: a?.medicaid_adult_dental_level ?? null,
    program: fr
      ? pick(fr.adult_medicaid, ["level", "level_label", "summary", "official_fee_schedule_url", "fee_schedule_effective_date", "checked_at", "source"])
      : null,
    ortho: slimPol(pol?.ortho),
    implants: slimPol(pol?.implants),
    policy_consulted: policy.meta.consulted,
    billing: {
      pct_dentists_billing_medicaid: sl.pct_dentists_billing_medicaid_2023_2024 ?? null,
      dentists_billing_medicaid: sl.dentists_billing_medicaid_2023_2024 ?? null,
      dentists_active_nppes: sl.dentists_active_nppes_2026_08 ?? null,
      quality_flag: sl.medicaid_billing_quality_flag ?? null,
    },
    schedule: schedules[code] ?? null,
  };
  options[code] = {
    slug: fr?.slug ?? null,
    dental_schools: fr?.dental_schools ?? null,
    fqhc: fr?.fqhc ?? null,
    mission_of_mercy: fr?.mission_of_mercy ?? null,
    charity: fr?.charity ?? null,
    checked_at: fr?.adult_medicaid?.checked_at ?? null,
    hpsa_snapshot_date: atlas.hpsa_snapshot_date,
    acs_vintage: atlas.acs_vintage,
    counties: atlas.counties.map((c) => ({
      fips: c.fips,
      county: c.county,
      hpsa: pick(c.hpsa ?? {}, ["designations", "max_score", "population"]),
      income_level: c.income_level,
      desert: c.desert,
    })),
  };
}
// Fee source cross-check: the API's official_fee URL should be the schedule file we read the scope from.
for (const [code, c] of Object.entries(medicaid))
  for (const [st, s] of Object.entries(c.states))
    if (s.official_fee && schedules[st] && s.official_fee.source_url !== schedules[st].source_url)
      issues.push(`${code}/${st}: official_fee.source_url differs from fee-schedule file source_url`);

// ---------------------------------------------------------------------------
// Chain published prices (Affordable Dentures & Implants), state aggregates only
// ---------------------------------------------------------------------------
const chain = json("public/api/v1/chains/affordable-dentures-implants.json");
const CHAIN_KEYS = ["economyNew", "premiumNew", "routineExtraction"];
const chainsOut = {
  "affordable-dentures-implants": {
    chain: chain.meta.chain,
    crawled_at: chain.meta.crawled_at,
    source: chain.meta.source,
    api_url: `${SITE}/api/v1/chains/affordable-dentures-implants.json`,
    disclaimer: chain.meta.disclaimer,
    services: Object.fromEntries(
      ["economy", "premium", "routineExtraction"].map((k) => [k, pick(chain.services[k], ["label", "unit", "sourceName"])]),
    ),
    byState: Object.fromEntries(
      chain.byState.map((s) => [
        s.code,
        { offices: s.offices, ...Object.fromEntries(CHAIN_KEYS.filter((k) => s[k]).map((k) => [k, pick(s[k], ["n", "min", "median", "max"])])) },
      ]),
    ),
  },
};

// ---------------------------------------------------------------------------
// write + manifest
// ---------------------------------------------------------------------------
fs.mkdirSync(out, { recursive: true });
const outputs = [];
const files = {
  "medicaid.json": medicaidOut,
  "states.json": states,
  "procedures.json": procedures,
  "rules.json": rules,
  "options.json": options,
  "chains.json": chainsOut,
};
for (const [name, data] of Object.entries(files)) {
  const buf = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(path.join(out, name), buf);
  outputs.push({ file: name, sha256: sha(buf), bytes: buf.length });
}
const manifest = {
  synced_at: new Date().toISOString(),
  api_generated_at: medMeta.generated_at,
  site_dir: path.relative(root, site).replaceAll("\\", "/"),
  inputs,
  outputs,
  issues,
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`synced ${inputs.length} inputs -> ${outputs.length} files (${outputs.reduce((n, o) => n + o.bytes, 0)} bytes), ${issues.length} issue(s)`);
for (const i of issues) console.log(`  issue: ${i}`);
