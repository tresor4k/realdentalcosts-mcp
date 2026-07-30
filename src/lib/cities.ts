/**
 * Loader + types for the city dataset (src/data/cities.json), extracted
 * mechanically by scripts/extract-cities.mjs from the PUBLISHED Real Dental
 * Costs city CSV (us-dental-cost-by-city-2026.csv, DOI 10.5281/zenodo.20819438).
 * Only the observed single-implant average exists per city upstream — the
 * unpublished per-city veneer/braces figures were retired in the 2026-07
 * data-integrity work on the source site.
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface CityEntry {
  name: string;
  slug: string;
  clinics?: number;
  costs: {
    Implants: { avg: number };
  };
}

export interface StateEntry {
  code: string;
  name: string;
  slug: string;
  cities: CityEntry[];
}

export interface CitiesDataset {
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
