/**
 * Loader + types for the reduced city/state dataset (src/data/cities.json),
 * derived mechanically from realdentalcosts.com `data/dental_costs.json` by
 * scripts/extract-cities.mjs. See that script for the exact field mapping —
 * no cost values are altered.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface ProcedureTriple {
  avg: number;
  min?: number;
  max?: number;
  insurance?: {
    coverageRate?: number;
    medicaidNotes?: { en?: string; es?: string };
  };
}

export interface CityEntry {
  name: string;
  slug: string;
  clinics?: number;
  costs: {
    Implants?: { avg: number };
    Veneers?: { avg: number };
    Braces?: { avg: number };
  };
}

export interface StateEntry {
  code: string;
  name: string;
  slug: string;
  insuranceCoverage?: number;
  costs: {
    Implants?: ProcedureTriple;
    Veneers?: ProcedureTriple;
    Braces?: ProcedureTriple;
  };
  cities: CityEntry[];
}

export interface CitiesDataset {
  national: {
    Implants?: ProcedureTriple;
    Veneers?: ProcedureTriple;
    Braces?: ProcedureTriple;
  };
  states: StateEntry[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// At runtime this file lives in dist/lib/cities.js; the data is copied to
// dist/data/cities.json by the `build` npm script (tsc does not copy JSON).
const DATA_PATH = path.join(__dirname, "..", "data", "cities.json");

let cached: CitiesDataset | null = null;

export function loadCitiesData(): CitiesDataset {
  if (cached) return cached;
  const raw = fs.readFileSync(DATA_PATH, "utf8");
  cached = JSON.parse(raw) as CitiesDataset;
  return cached;
}

/** Normalize for case/accent-insensitive matching. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

export function findCity(
  cityQuery: string,
  stateCode?: string,
): { city: CityEntry; state: StateEntry } | undefined {
  const data = loadCitiesData();
  const q = normalize(cityQuery);
  const states = stateCode
    ? data.states.filter((s) => s.code === stateCode.toUpperCase())
    : data.states;
  for (const state of states) {
    for (const city of state.cities) {
      if (normalize(city.name) === q) {
        return { city, state };
      }
    }
  }
  return undefined;
}

/** Suggest up to `limit` city names that start with the same prefix, optionally scoped to a state. */
export function suggestCities(
  cityQuery: string,
  stateCode?: string,
  limit = 5,
): string[] {
  const data = loadCitiesData();
  const q = normalize(cityQuery);
  const prefix = q.slice(0, 3);
  const states = stateCode
    ? data.states.filter((s) => s.code === stateCode.toUpperCase())
    : data.states;
  const out: string[] = [];
  for (const state of states) {
    for (const city of state.cities) {
      if (normalize(city.name).startsWith(prefix)) {
        out.push(`${city.name}, ${state.code}`);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}
