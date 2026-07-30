#!/usr/bin/env node
/**
 * Mechanical extraction of the city dataset from the PUBLISHED Real Dental
 * Costs city CSV (the open dataset, DOI 10.5281/zenodo.20819438):
 *   public/data/us-dental-cost-by-city-2026.csv
 *   columns: rank,city,state,state_code,dental_clinics,implant_avg_usd
 *
 * NO VALUES ARE MODIFIED OR INVENTED. Only the observed single-implant
 * average is published per city upstream — the 2026-07 data-integrity work
 * on the source site retired the unpublished per-city veneer/braces figures,
 * so this dataset (and the dental_cost_by_city tool) now carries implants only.
 *
 * Usage:
 *   node scripts/extract-cities.mjs <path-to-us-dental-cost-by-city-2026.csv> [output-path]
 */
import fs from "node:fs";
import path from "node:path";

const srcPath = process.argv[2];
const outPath = process.argv[3] || path.join(process.cwd(), "src", "data", "cities.json");

if (!srcPath) {
  console.error("Usage: node scripts/extract-cities.mjs <path-to-us-dental-cost-by-city-2026.csv> [output-path]");
  process.exit(1);
}

function parseCsvLine(line) {
  const cells = [];
  let cur = "", inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const lines = fs.readFileSync(srcPath, "utf8").trim().split(/\r?\n/);
const header = parseCsvLine(lines[0]);
const EXPECTED = ["rank", "city", "state", "state_code", "dental_clinics", "implant_avg_usd"];
if (JSON.stringify(header) !== JSON.stringify(EXPECTED)) {
  console.error(`Unexpected CSV header. Expected: ${EXPECTED.join(",")} — got: ${header.join(",")}`);
  process.exit(1);
}

const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const byState = new Map();
for (const line of lines.slice(1)) {
  const [rank, city, state, code, clinics, implant] = parseCsvLine(line);
  if (!city) continue;
  const implantAvg = Number(implant);
  const nClinics = Number(clinics);
  if (!Number.isFinite(implantAvg) || implantAvg <= 0) {
    console.error(`Bad implant_avg_usd on rank ${rank} (${city})`);
    process.exit(1);
  }
  if (!byState.has(code)) byState.set(code, { code, name: state, slug: slugify(state), cities: [] });
  byState.get(code).cities.push({
    name: city,
    slug: slugify(city),
    clinics: Number.isFinite(nClinics) ? nClinics : undefined,
    costs: { Implants: { avg: implantAvg } },
  });
}

const states = [...byState.values()].sort((a, b) => a.code.localeCompare(b.code));
const totalCities = states.reduce((a, s) => a + s.cities.length, 0);
if (totalCities < 200) {
  console.error(`Sanity check failed: only ${totalCities} cities extracted (expected 200+).`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ states }));

const stat = fs.statSync(outPath);
console.log(`Wrote ${outPath} (${(stat.size / 1024).toFixed(1)} KB), ${states.length} states, ${totalCities} cities.`);
