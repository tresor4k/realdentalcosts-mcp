#!/usr/bin/env node
/**
 * Copies and reduces the PUBLISHED Real Dental Costs sources into src/data/rdc/
 * (the app reads nothing else). Values are copied verbatim — no recomputation —
 * so every number served by the app equals the open API v1.
 *
 * Usage: node scripts/sync-data.mjs [siteDir]   (default ../dentist/web, or RDC_SITE_DIR)
 * Writes src/data/rdc/{medicaid,states,procedures,rules,options,chains,meps,canada,programs}.json and
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
// Adult annual dollar cap: curated in THIS repo (one row = one verbatim quote), not in the site.
const CAPS = "data/medicaid-adult-dental-caps-2026.json";
const capsBuf = fs.readFileSync(path.join(root, CAPS));
inputs.push({ file: `mcp:${CAPS}`, sha256: sha(capsBuf), bytes: capsBuf.length });
const caps = Object.fromEntries(JSON.parse(capsBuf.toString("utf8")).states.map((c) => [c.state, c]));
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
  if (!caps[code]) issues.push(`${code}: no row in ${CAPS}`);
  const pol = policy.states.find((s) => s.code === code);
  const fr = free.states.find((s) => s.code === code);
  const atlas = json(`public/data/atlas/${code}.json`);
  const sl = atlas.state_layer;
  if (a && a.medicaid_adult_dental_level !== states[code].medicaid.adult_dental_coverage_level)
    issues.push(`${code}: acceptance CSV level=${a.medicaid_adult_dental_level} vs API v1 state=${states[code].medicaid.adult_dental_coverage_level}`);
  const slimPol = (p) =>
    p && pick(p, ["status", "under21", "adult_21plus", "note", "quote", "source_url", "source_title", "source_date"]);
  rules[code] = {
    cap: caps[code]
      ? pick(caps[code], ["cap_usd", "cap_kind", "period", "source_url", "source_title", "retrieved_at", "quote", "cross_check_url", "cross_check_quote", "note"])
      : null,
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
// MEPS (API v1 /meps/*.json): annual cross-sections + paired 2023-2024 change.
// The cross-sectional delta is NOT copied: the source itself says it is not confirmed
// by the paired Panel 28 estimates (no national trend to infer).
// ---------------------------------------------------------------------------
const mepsNat = json("public/api/v1/meps/national.json");
const mepsLong = json("public/api/v1/meps/longitudinal.json");
const mepsFile = (f) => pick(f, ["puf", "name", "released", "url"]);
const meps = {
  national: {
    endpoint: mepsNat.endpoint,
    title: mepsNat.title,
    source: mepsNat.provenance.source,
    computed_at: mepsNat.provenance.computed_at,
    generated_at: mepsNat.meta.generated_at,
    files: mepsNat.provenance.files.map(mepsFile),
    caveats: mepsNat.caveats,
    years: Object.fromEntries(
      Object.entries(mepsNat.data).filter(([k]) => /^y\d{4}$/.test(k)).map(([k, v]) => [k.slice(1), v]),
    ),
  },
  longitudinal: {
    endpoint: mepsLong.endpoint,
    title: mepsLong.title,
    source: mepsLong.provenance.source,
    generated_at: mepsLong.meta.generated_at,
    files: mepsLong.provenance.files.map(mepsFile),
    caveats: mepsLong.caveats,
    paired_change: Object.fromEntries(
      Object.entries(mepsLong.data.paired_change_2024_minus_2023).map(([k, v]) => [k, pick(v, ["value", "ci95", "significant_at_95pct"])]),
    ),
    reading: mepsLong.data.comparison_with_cross_sectional?.reading ?? null,
  },
};
for (const y of ["2023", "2024"]) if (!meps.national.years[y]) issues.push(`meps: no ${y} cross-section`);

// ---------------------------------------------------------------------------
// Canada: provincial cost index (CSV under DOI 10.5281/zenodo.20744781), CDCP coverage
// matrix (CSV) and CDCP income tiers (lib/canada-data.ts CDCP_TIERS).
// Rows hit by an open defect in audit/qualite/ISSUES.md are withheld (no value copied).
// ---------------------------------------------------------------------------
const CA_CSV = "public/data/canada-dental-cost-index-by-province-2026.csv";
const CDCP_CSV = "public/data/cdcp-coverage-matrix-2026.csv";
const UNDER_REVIEW = {
  "BC/recall_exam": { issue: "E-081", defect_amount: 62.6, note: "The figure published for this row is the BCDA code for a specific examination, not the recall examination code; correction scheduled with dataset v1.1." },
  "ON/recall_exam": { issue: "E-086", defect_amount: 139, note: "The published range mixes a complete-examination fee and a new-patient-exam fee; no public relay gives the Ontario recall examination code." },
  "NB/recall_exam": { issue: "E-087", defect_amount: 82, note: "The published figure is a 2025 examination code; the NBDS 2026 guide publishes a different recall examination amount. Correction scheduled with dataset v1.1." },
  "ON/filling_1surface_composite": { issue: "E-094", defect_amount: 342, note: "The published figure is the midpoint of a 1-to-5-surface range withdrawn by the source manifest on 2026-08-03; correction scheduled with dataset v1.1." },
  "NS/simple_extraction": { issue: "E-090", defect_amount: 162, note: "The published figure comes from the NSDA 2024 guide, not the 2026 guide; correction scheduled with dataset v1.1." },
};
const num = (s) => (s === "" || s == null ? null : Number(s));
const canada = { provinces: {}, cdcp: {} };
for (const r of csv(read(CA_CSV))) {
  const p = (canada.provinces[r.province_code] ??= { name: r.province, fees: {} });
  const rev = UNDER_REVIEW[`${r.province_code}/${r.procedure}`];
  if (rev) {
    if (num(r.amount_cad) !== rev.defect_amount)
      issues.push(`canada ${r.province_code}/${r.procedure}: amount ${r.amount_cad} != defect value ${rev.defect_amount} of ${rev.issue}: re-check before releasing the row`);
    p.fees[r.procedure] = { data_quality: "under_review", issue: rev.issue, note: rev.note, source_url: r.source_url };
    continue;
  }
  p.fees[r.procedure] = {
    amount_cad: num(r.amount_cad),
    min_cad: num(r.min_cad),
    max_cad: num(r.max_cad),
    is_estimate: r.is_estimate === "true",
    source_url: r.source_url,
  };
}
for (const k of Object.keys(UNDER_REVIEW)) {
  const [pc, pr] = k.split("/");
  if (!canada.provinces[pc]?.fees[pr]) issues.push(`canada ${k}: row under review not found in ${CA_CSV}`);
}
const CDCP_ROW = {
  recall_exam: "Examen de rappel",
  scaling_per_unit: "Détartrage",
  filling_1surface_composite: "Obturation permanente",
  simple_extraction: "Extraction simple",
  root_canal_molar: "Traitement de canal",
  complete_denture_per_arch: "Prothèse complète",
  partial_denture_cast_metal: "Prothèse partielle",
  crown_ceramic: "Couronne /",
  single_implant_fixture_abutment_crown: "Implant dentaire",
};
const cdcpRows = csv(read(CDCP_CSV));
for (const [key, prefix] of Object.entries(CDCP_ROW)) {
  const r = cdcpRows.find((x) => x.procedure.startsWith(prefix));
  if (!r) { issues.push(`cdcp: no matrix row for ${key}`); continue; }
  canada.cdcp[key] = {
    matrix_row: r.procedure,
    covered: r.covered,
    preauth_required: r.preauth_required.toLowerCase(),
    rule_fr: r.cdcp_reimbursement_basis,
    notes_fr: r.notes,
    source_url: r.source_url,
  };
}
const caTs = read("lib/canada-data.ts");
const tierBlock = caTs.match(/CDCP_TIERS[^=]*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
canada.tiers = [...tierBlock.matchAll(/\{\s*id:\s*"([^"]+)",\s*bandEn:\s*"([^"]+)",\s*bandFr:\s*"([^"]+)",\s*cdcpSharePct:\s*(\d+),\s*copayPct:\s*(\d+)\s*\}/g)].map((m) => ({
  id: m[1],
  band_en: m[2],
  band_fr: m[3],
  lower_bound_cad: /^Under/.test(m[2]) ? 0 : Number(m[2].match(/\$([\d,]+)/)[1].replace(/,/g, "")),
  cdcp_share_pct: Number(m[4]),
  copay_pct: Number(m[5]),
}));
if (canada.tiers.length !== 4) issues.push(`cdcp: ${canada.tiers.length} income tiers parsed from lib/canada-data.ts, expected 4`);
if (canada.tiers.some((t, i) => t.cdcp_share_pct + t.copay_pct !== 100 || (i && t.lower_bound_cad <= canada.tiers[i - 1].lower_bound_cad)))
  issues.push("cdcp: income tiers not ascending or share + copay != 100");
// Tier source as cited by the site (app/ca/cdcp-eligibility-income-tiers: "Source: canada.ca/.../coverage.html, effective 2026").
canada.tiers_source = {
  source: "Government of Canada, Canadian Dental Care Plan coverage page (co-payment by adjusted family net income)",
  source_url: "https://www.canada.ca/en/services/benefits/dental/dental-care-plan/coverage.html",
  period: "2026",
};
canada.dataset = {
  doi_url: "https://doi.org/10.5281/zenodo.20744781",
  csv_url: `${SITE}/data/canada-dental-cost-index-by-province-2026.csv`,
  cdcp_csv_url: `${SITE}/data/cdcp-coverage-matrix-2026.csv`,
  audited_at: "2026-06-18",
};

// ---------------------------------------------------------------------------
// Lot C2: dated program changes (TX 2026-09 rate file, verbatim) + Medicare dental exclusion (curated in THIS repo)
// ---------------------------------------------------------------------------
const tx = json("data/tx-medicaid-dental-rate-change-2026-09.json");
const MEDICARE = "data/medicare-dental-exclusion-2026.json";
const medicareBuf = fs.readFileSync(path.join(root, MEDICARE));
inputs.push({ file: `mcp:${MEDICARE}`, sha256: sha(medicareBuf), bytes: medicareBuf.length });
const programs = {
  tx_rate_change: {
    ...pick(tx, ["code", "program", "effective_date", "previous_effective_date", "published_at", "news_url", "file_url", "hearing", "n_codes", "licence_note"]),
    rows: tx.rows.map((r) => pick(r, ["code", "age_range", "setting", "fee_before", "fee_after", "pct_change"])),
  },
  medicare: JSON.parse(medicareBuf.toString("utf8")),
};
if (programs.tx_rate_change.rows.length !== tx.n_codes) issues.push(`tx rate change: ${tx.rows.length} rows vs n_codes ${tx.n_codes}`);
for (const q of programs.medicare.quotes) if (q.quote.length > 300) issues.push(`medicare quote ${q.id} longer than 300 characters`);

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
  "meps.json": meps,
  "canada.json": canada,
  "programs.json": programs,
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
