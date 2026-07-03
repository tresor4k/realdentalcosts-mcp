#!/usr/bin/env node
/**
 * Mechanical extraction of a reduced city/state dental-cost dataset from the
 * realdentalcosts.com source-of-truth `data/dental_costs.json`.
 *
 * NO VALUES ARE MODIFIED OR INVENTED. This script only reshapes/prunes
 * fields (drops patientVoice/affordabilityScore/ratings/tags — not needed by
 * the MCP tools) and copies costs and insurance notes verbatim.
 *
 * NOTE ON CITY-LEVEL DATA: the source only stores a single observed cost per
 * city per procedure (no separate min/max at city granularity — min/max only
 * exist at state and national level in the source). We keep that as-is
 * (city costs = { avg: <source value> }) rather than fabricate a range.
 *
 * Usage:
 *   node scripts/extract-cities.mjs <path-to-dental_costs.json> <output-path>
 *
 * Defaults assume this script is run from a checkout that also has access to
 * the original site's data/dental_costs.json path passed explicitly (the
 * file is NOT vendored into this repo beyond the derived output).
 */
import fs from "node:fs";
import path from "node:path";

const srcPath = process.argv[2];
const outPath = process.argv[3] || path.join(process.cwd(), "src", "data", "cities.json");

if (!srcPath) {
  console.error("Usage: node scripts/extract-cities.mjs <path-to-dental_costs.json> [output-path]");
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(srcPath, "utf8"));

if (!raw.national || !Array.isArray(raw.states)) {
  console.error("Unexpected source shape: expected { national, states: [] }");
  process.exit(1);
}

function pickProcedureState(costs, key) {
  const c = costs?.[key];
  if (!c) return undefined;
  const out = { avg: c.avg, min: c.min, max: c.max };
  if (c.insurance) {
    out.insurance = {
      coverageRate: c.insurance.coverageRate,
      medicaidNotes: c.insurance.medicaidNotes
        ? { en: c.insurance.medicaidNotes.en, es: c.insurance.medicaidNotes.es }
        : undefined,
    };
  }
  return out;
}

function pickProcedureNational(costs, key) {
  const c = costs?.[key];
  if (!c) return undefined;
  return { avg: c.avg, min: c.min, max: c.max };
}

const national = {
  Implants: pickProcedureNational(raw.national, "Implants"),
  Veneers: pickProcedureNational(raw.national, "Veneers"),
  Braces: pickProcedureNational(raw.national, "Braces"),
};

const states = raw.states.map((s) => ({
  code: s.code,
  name: s.name,
  slug: s.slug,
  insuranceCoverage: s.insuranceCoverage,
  costs: {
    Implants: pickProcedureState(s.costs, "Implants"),
    Veneers: pickProcedureState(s.costs, "Veneers"),
    Braces: pickProcedureState(s.costs, "Braces"),
  },
  cities: (s.cities || []).map((c) => ({
    name: c.name,
    slug: c.slug,
    clinics: c.clinics,
    costs: {
      Implants: c.costs?.Implants !== undefined ? { avg: c.costs.Implants } : undefined,
      Veneers: c.costs?.Veneers !== undefined ? { avg: c.costs.Veneers } : undefined,
      Braces: c.costs?.Braces !== undefined ? { avg: c.costs.Braces } : undefined,
    },
  })),
}));

const reduced = { national, states };

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(reduced));

const stat = fs.statSync(outPath);
console.log(`Wrote ${outPath} (${(stat.size / 1024).toFixed(1)} KB), ${states.length} states, ${states.reduce((a, s) => a + s.cities.length, 0)} cities.`);
