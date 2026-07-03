#!/usr/bin/env node
/**
 * realdentalcosts-mcp — stdio MCP server exposing US dental cost lookups
 * backed by the Real Dental Costs US Dental Cost Index 2026 dataset.
 *
 * Four tools: dental_cost_by_state, dental_cost_by_city,
 * out_of_pocket_estimate, dental_national_average.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  COMPARE_PROCEDURES,
  COMPARE_STATES,
  COMPARE_PRICES,
} from "./lib/compare-data.js";
import { outOfPocket, nationalTriple, PROC_LABELS_ES } from "./lib/pricing.js";
import { findCity, suggestCities, loadCitiesData } from "./lib/cities.js";

const SOURCE = "Real Dental Costs — US Dental Cost Index 2026";

const PROCEDURE_IDS = COMPARE_PROCEDURES.map((p) => p.id) as [string, ...string[]];
const STATE_CODES = COMPARE_STATES.map((s) => s.code) as [string, ...string[]];

const procedureById = new Map(COMPARE_PROCEDURES.map((p) => [p.id, p]));
const stateByCode = new Map(COMPARE_STATES.map((s) => [s.code, s]));

const langSchema = z
  .enum(["en", "es"])
  .default("en")
  .describe('Response language for labels/notes: "en" (default) or "es".');

const procedureEnum = z
  .enum(PROCEDURE_IDS)
  .describe(
    `Procedure id. One of: ${COMPARE_PROCEDURES.map((p) => `${p.id} (${p.label})`).join(", ")}.`,
  );

const stateEnum = z
  .enum(STATE_CODES)
  .describe(
    `Two-letter US state code (or DC). One of: ${STATE_CODES.join(", ")}.`,
  );

function procedureLabel(id: string, lang: "en" | "es"): string {
  const p = procedureById.get(id);
  if (!p) return id;
  return lang === "es" ? PROC_LABELS_ES[id] ?? p.label : p.label;
}

function disclaimer(lang: "en" | "es"): string {
  return lang === "es"
    ? "Datos de investigación de mercado sobre precios, no es asesoramiento médico ni financiero."
    : "Market research pricing data, not medical or financial advice.";
}

function refUrl(path: string, lang: "en" | "es"): string {
  const base = "https://realdentalcosts.com";
  return lang === "es" ? `${base}/es${path}` : `${base}/en${path}`;
}

const server = new McpServer({
  name: "realdentalcosts-mcp",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// 1. dental_cost_by_state
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_cost_by_state",
  {
    title: "Dental cost by US state",
    description:
      'Get the low/average/high cash price for a dental procedure in a specific US state, compared to the national average. Example: procedure="implant", state="CA" returns California\'s single-implant price range plus how it compares to the 51-state (incl. DC) national average and the state\'s dental cost index. Market research pricing data, not medical or financial advice.',
    inputSchema: {
      procedure: procedureEnum,
      state: stateEnum,
      lang: langSchema,
    },
  },
  async ({ procedure, state, lang }) => {
    const proc = procedureById.get(procedure);
    const st = stateByCode.get(state);
    if (!proc || !st) {
      return errorResult(
        `Unknown procedure or state. Valid procedures: ${PROCEDURE_IDS.join(", ")}. Valid states: ${STATE_CODES.join(", ")}.`,
      );
    }
    const triple = COMPARE_PRICES[state][procedure];
    const [low, avg, high] = triple;
    const [natLow, natAvg, natHigh] = nationalTriple(procedure);
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/compare/", lang),
      procedure: { id: procedure, label: procedureLabel(procedure, lang), category: proc.cat },
      state: { code: st.code, name: st.name, costIndex: st.index },
      cashPrice: { low, avg, high, currency: "USD" },
      nationalAverage: {
        low: Math.round(natLow),
        avg: Math.round(natAvg),
        high: Math.round(natHigh),
        currency: "USD",
      },
      vsNationalAvgPct: Math.round(((avg - natAvg) / natAvg) * 1000) / 10,
      disclaimer: disclaimer(lang),
    };
    return jsonResult(payload);
  },
);

// ---------------------------------------------------------------------------
// 2. dental_cost_by_city
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_cost_by_city",
  {
    title: "Dental cost by US city",
    description:
      'Get average dental costs (implants, veneers, braces) and clinic counts for a specific US city. Example: city="Miami" returns Miami\'s average prices plus the parent state\'s low/high range for context (city-level data in the source is a single observed average per procedure — no separate city min/max exists upstream). Pass "state" (2-letter code) to disambiguate same-named cities. Market research pricing data, not medical or financial advice.',
    inputSchema: {
      city: z.string().min(1).describe('City name, e.g. "Austin" or "San Diego".'),
      state: stateEnum.optional().describe("Optional 2-letter state code to disambiguate."),
      lang: langSchema,
    },
  },
  async ({ city, state, lang }) => {
    const found = findCity(city, state);
    if (!found) {
      const suggestions = suggestCities(city, state);
      return errorResult(
        `No city matching "${city}"${state ? ` in state ${state}` : ""} found in the dataset.` +
          (suggestions.length
            ? ` Did you mean: ${suggestions.join(", ")}?`
            : " Try a different spelling or omit the state filter."),
      );
    }
    const { city: c, state: st } = found;
    const procNames = ["Implants", "Veneers", "Braces"] as const;
    const costs: Record<string, unknown> = {};
    for (const p of procNames) {
      const cityCost = c.costs[p];
      const stateCost = st.costs[p];
      costs[p] = {
        cityAvg: cityCost?.avg,
        stateRange: stateCost
          ? { low: stateCost.min, avg: stateCost.avg, high: stateCost.max }
          : undefined,
      };
    }
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/us-dental-cost-index/", lang),
      city: c.name,
      state: { code: st.code, name: st.name },
      clinics: c.clinics,
      currency: "USD",
      costs,
      disclaimer: disclaimer(lang),
    };
    return jsonResult(payload);
  },
);

// ---------------------------------------------------------------------------
// 3. out_of_pocket_estimate
// ---------------------------------------------------------------------------
server.registerTool(
  "out_of_pocket_estimate",
  {
    title: "Out-of-pocket dental cost estimate",
    description:
      'Estimate what a patient actually pays for a dental procedure in a given state under a payment mode: "cash" (full list price), "insurance" (typical US PPO plan: preventive ~100%, basic ~80% up to a $1,500 annual max, major/ortho ~50% up to the same max, cosmetic/implants not covered), or "savings_plan" (dental discount plan, ~20-40% off list price). Example: procedure="crown", state="TX", mode="insurance". Market research pricing data, not medical or financial advice.',
    inputSchema: {
      procedure: procedureEnum,
      state: stateEnum,
      mode: z
        .enum(["cash", "insurance", "savings_plan"])
        .describe('Payment mode: "cash", "insurance", or "savings_plan".'),
      lang: langSchema,
    },
  },
  async ({ procedure, state, mode, lang }) => {
    const proc = procedureById.get(procedure);
    if (!proc) {
      return errorResult(`Unknown procedure "${procedure}". Valid: ${PROCEDURE_IDS.join(", ")}.`);
    }
    const triple = COMPARE_PRICES[state][procedure];
    const payMode = mode === "savings_plan" ? "savings" : (mode as "cash" | "insurance");
    const { vals, note } = outOfPocket(triple, proc.cat, payMode);
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/dental-insurance/", lang),
      procedure: { id: procedure, label: procedureLabel(procedure, lang), category: proc.cat },
      state,
      mode,
      listPrice: { low: triple[0], avg: triple[1], high: triple[2], currency: "USD" },
      estimatedOutOfPocket: {
        low: Math.round(vals[0]),
        avg: Math.round(vals[1]),
        high: Math.round(vals[2]),
        currency: "USD",
      },
      assumptions: note,
      disclaimer: disclaimer(lang),
    };
    return jsonResult(payload);
  },
);

// ---------------------------------------------------------------------------
// 4. dental_national_average
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_national_average",
  {
    title: "National average dental cost",
    description:
      'Get the US national average low/avg/high cash price for a dental procedure (mean across all 51 states + DC), plus which state is cheapest and priciest on average. Example: procedure="veneer". Market research pricing data, not medical or financial advice.',
    inputSchema: {
      procedure: procedureEnum,
      lang: langSchema,
    },
  },
  async ({ procedure, lang }) => {
    const proc = procedureById.get(procedure);
    if (!proc) {
      return errorResult(`Unknown procedure "${procedure}". Valid: ${PROCEDURE_IDS.join(", ")}.`);
    }
    const [low, avg, high] = nationalTriple(procedure);
    let cheapest = STATE_CODES[0];
    let priciest = STATE_CODES[0];
    for (const code of STATE_CODES) {
      const a = COMPARE_PRICES[code][procedure][1];
      if (a < COMPARE_PRICES[cheapest][procedure][1]) cheapest = code;
      if (a > COMPARE_PRICES[priciest][procedure][1]) priciest = code;
    }
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/us-dental-cost-index/", lang),
      procedure: { id: procedure, label: procedureLabel(procedure, lang), category: proc.cat },
      nationalAverage: {
        low: Math.round(low),
        avg: Math.round(avg),
        high: Math.round(high),
        currency: "USD",
      },
      cheapestState: {
        code: cheapest,
        name: stateByCode.get(cheapest)?.name,
        avg: COMPARE_PRICES[cheapest][procedure][1],
      },
      priciestState: {
        code: priciest,
        name: stateByCode.get(priciest)?.name,
        avg: COMPARE_PRICES[priciest][procedure][1],
      },
      disclaimer: disclaimer(lang),
    };
    return jsonResult(payload);
  },
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

// Touch loadCitiesData at startup so a missing/corrupt data file fails fast
// with a clear error instead of on the first tool call.
loadCitiesData();

const transport = new StdioServerTransport();
await server.connect(transport);
