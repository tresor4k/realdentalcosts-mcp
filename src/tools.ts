/**
 * Shared tool registration for realdentalcosts-mcp, used by both the stdio
 * binary (src/index.ts) and the Streamable HTTP entry point (src/http.ts).
 *
 * createServer() registers 3 cost tools + 4 treatment-plan tools (the modelled
 * out-of-pocket tool was removed). createServer({ appsSdk: true }) additionally
 * returns `structuredContent` and declares the MCP Apps widgets (price card, plan card;
 * versioned URIs in widget.ts, earlier URIs still served through ResourceTemplates).
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  COMPARE_PROCEDURES,
  COMPARE_STATES,
  COMPARE_PRICES,
} from "./lib/compare-data.js";
import { nationalTriple, PROC_LABELS_ES } from "./lib/pricing.js";
import { findCity, suggestCities } from "./lib/cities.js";
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML, PLAN_WIDGET_URI, PLAN_WIDGET_HTML } from "./widget.js";
import { benchmarkTreatmentPlan, medicaidAdultDentalRules, medicaidPaidByCode, lowCostDentalOptions } from "./lib/rdc.js";

const SOURCE = "Real Dental Costs — US Dental Cost Index 2026";
const API_BASE = "https://realdentalcosts.com/api/v1";

/** Stable public slugs of the open JSON API (same ids as COMPARE_PROCEDURES). */
const PROC_SLUGS: Record<string, string> = {
  exam: "exam-cleaning-xrays",
  filling: "composite-filling",
  deepclean: "deep-cleaning-srp",
  extraction: "tooth-extraction",
  whitening: "teeth-whitening",
  rootcanal: "root-canal",
  crown: "dental-crown",
  veneer: "porcelain-veneer",
  braces: "braces",
  implant: "dental-implant",
  dentures: "dentures",
  allon4: "all-on-4",
};

/** Provenance notes per pricing basis (mirrors the upstream compare-data doc). */
const BASIS_NOTES: Record<string, { en: string; es: string }> = {
  observed: {
    en: "The state AVERAGE is a measured price (implant = Real Dental Costs' own observed series, DOI 10.5281/zenodo.20531728; crown/veneer/braces/dentures = ASQ360/CareCredit Average Procedural Cost Study 2023-2024). The low/high band around it is modelled from national ratios, not an observed percentile.",
    es: "El PROMEDIO estatal es un precio medido (implante = serie observada propia de Real Dental Costs, DOI 10.5281/zenodo.20531728; corona/carilla/brackets/dentaduras = estudio ASQ360/CareCredit 2023-2024). La banda low/high alrededor es modelada a partir de ratios nacionales, no un percentil observado.",
  },
  estimated: {
    en: "No per-state source exists: the national figure is scaled by the state's Restorative Cost Index. Defensible only inside the restorative regime — treat as an estimate.",
    es: "No existe fuente estatal: la cifra nacional se escala con el Índice de Coste Restaurador del estado. Solo defendible dentro del régimen restaurador — trátese como estimación.",
  },
  national: {
    en: "Cosmetic procedure with no per-state source. Cosmetic pricing does not follow restorative geography, so no state variation is invented: every state carries the national range.",
    es: "Procedimiento estético sin fuente estatal. Los precios estéticos no siguen la geografía restauradora, así que no se inventa variación estatal: todos los estados llevan el rango nacional.",
  },
};

const INDEX_NOTE = {
  en: "Restorative Cost Index (100 = national observed implant average). Valid ONLY for implant/crown/denture prices — it does not predict orthodontic (braces) or cosmetic (veneer) prices.",
  es: "Índice de Coste Restaurador (100 = promedio nacional observado de implantes). Válido SOLO para implantes/coronas/dentaduras — no predice precios de ortodoncia (brackets) ni estéticos (carillas).",
};

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

// ES paths that differ from EN ("seguros"), or have no ES page (null = link the EN page).
const ES_PATHS: Record<string, string | null> = {
  "/dental-insurance/": "/seguros/",
  "/us-dental-cost-index/": null,
};

function refUrl(path: string, lang: "en" | "es"): string {
  const base = "https://realdentalcosts.com";
  if (lang !== "es") return `${base}/en${path}`;
  const es = path in ES_PATHS ? ES_PATHS[path] : path;
  return es === null ? `${base}/en${path}` : `${base}/es${es}`;
}

/** Summary rendered by the price-card widget (Apps SDK mode only). */
interface PriceCard {
  title: string;
  location: string;
  low: number;
  avg: number;
  high: number;
  avgLabel: string;
  rangeNote: string;
  url: string;
}

const UTM = "utm_source=mcp&utm_medium=mcp";

/**
 * Site page for the widget link. Every target is listed in the live sitemap
 * (checked 2026-10-09): state hubs /{lang}/{slug}/ for all states except DC,
 * and the English procedure pages from COMPARE_PROCEDURES[].link.
 */
function cardUrl(procedure: string, lang: "en" | "es", stateSlug?: string): string {
  const base = "https://realdentalcosts.com";
  const path =
    stateSlug && stateSlug !== "district-of-columbia"
      ? `/${lang}/${stateSlug}/`
      : procedureById.get(procedure)?.link ?? "/en/compare/";
  return `${base}${path}?${UTM}`;
}

/**
 * Aggregate-only usage log (HTTP mode): per-tool call counts per UTC day, written to
 * stderr at most once a minute and at exit. No arguments, IP, headers or user agent.
 */
const usage = new Map<string, number>();
let usageFlushedAt = Date.now();
function flushUsage() {
  if (!usage.size) return;
  process.stderr.write(JSON.stringify({ evt: "usage", day: new Date().toISOString().slice(0, 10), counts: Object.fromEntries(usage) }) + "\n");
  usage.clear();
  usageFlushedAt = Date.now();
}
function countCall(tool: string) {
  usage.set(tool, (usage.get(tool) ?? 0) + 1);
  if (Date.now() - usageFlushedAt >= 60_000) flushUsage();
}
process.once("exit", flushUsage);

export interface CreateServerOptions {
  /** Add structuredContent, the widget _meta on each tool and the widget resources (remote server). */
  appsSdk?: boolean;
  /** utm_source of every realdentalcosts.com link: chatgpt (/mcp), claude (/claude), mcp (stdio, default). */
  utm?: string;
  /** false: no `_meta.ui.domain` on the widgets (/claude: Claude expects its own value there, ChatGPT an https origin). */
  uiDomain?: boolean;
  /** Origin the widgets are served for (`_meta.ui.domain`): MCP_PUBLIC_ORIGIN, else https://mcp.realdentalcosts.com. */
  publicOrigin?: string;
}

export const DEFAULT_PUBLIC_ORIGIN = "https://mcp.realdentalcosts.com";
const SITE_ORIGIN = "https://realdentalcosts.com";

function checkedOrigin(given?: string): string {
  const raw = given ?? process.env.MCP_PUBLIC_ORIGIN ?? DEFAULT_PUBLIC_ORIGIN;
  const u = new URL(raw);
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:"))
    throw new Error(`MCP_PUBLIC_ORIGIN "${raw}" must be https (http only for localhost)`);
  return u.origin;
}

/** Required closing sentence of every tool description (test/descriptions.test.mjs). */
export const DO_NOT =
  "Do not use for: diagnosis, treatment choice, a named insurer's plan price, dentist recommendations, countries other than the US and Canada.";
const STAMP = " Observed market research with a source URL and period on every figure; not a quote, not medical advice.";
const INSTRUCTIONS =
  "Real Dental Costs gives observed US dental cost research: cash bands for 12 procedures by state, by city (implants) and nationally; what Medicaid paid per claim line for 61 CDT codes; each state's adult Medicaid dental rule and annual dollar cap; a line-by-line check of a treatment plan; and low-cost care routes (dental schools, health centers, shortage areas). Every figure carries its source URL and period, and a missing figure says no_source_at_this_level instead of being invented. Observed market research, not quotes, not medical advice. The tools do not cover diagnosis, treatment choice, a named insurer's plan, dentist recommendations or countries other than the US and Canada.";

export function createServer({ appsSdk = false, utm = "mcp", uiDomain = true, publicOrigin }: CreateServerOptions = {}): McpServer {
const origin = appsSdk ? checkedOrigin(publicOrigin) : DEFAULT_PUBLIC_ORIGIN;
const server = new McpServer(
  {
    name: "realdentalcosts-mcp",
    title: "Real Dental Costs",
    version: "0.2.0",
    websiteUrl: `${SITE_ORIGIN}/`,
  },
  { instructions: INSTRUCTIONS },
);

// Every link to realdentalcosts.com is built with utm_source=mcp; the host's own value replaces it.
const tagUtm = <T>(o: T): T =>
  utm === "mcp" ? o : (JSON.parse(JSON.stringify(o).split("utm_source=mcp&").join(`utm_source=${encodeURIComponent(utm)}&`)) as T);

const ann = (title: string) => ({ title, readOnlyHint: true, destructiveHint: false, openWorldHint: false });

const uiMeta = (uri: string, invoking: string, invoked: string) =>
  appsSdk
    ? {
        _meta: {
          ui: { resourceUri: uri },
          "openai/outputTemplate": uri,
          "openai/toolInvocation/invoking": invoking,
          "openai/toolInvocation/invoked": invoked,
        },
      }
    : {};

const toolMeta = uiMeta(WIDGET_URI, "Looking up dental costs…", "Dental costs ready");

if (appsSdk) {
  const PRICE_TEXT =
    "Shows the low / average / high cash band in US dollars for a dental procedure in a US state or city, with its source (market research, not medical advice).";
  const PLAN_TEXT =
    "Line-by-line check of a dental treatment plan against sourced references: state cash band, Medicaid paid per claim line (T-MSIS), official fee schedule, plus the state's adult Medicaid rule and source notes.";
  const contents = (uri: string, html: string, description: string) => ({
    contents: [
      {
        uri,
        mimeType: WIDGET_MIME,
        text: html,
        _meta: {
          // no network access: the widget only renders the tool result it is given
          ui: { prefersBorder: true, ...(uiDomain ? { domain: origin } : {}), csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetDomain": origin,
          "openai/widgetDescription": description,
          "openai/widgetPrefersBorder": true,
          // openExternal targets only (links to realdentalcosts.com pages), not a fetch origin
          "openai/widgetCSP": { connect_domains: [], resource_domains: [], redirect_domains: [SITE_ORIGIN] },
        },
      },
    ],
  });
  server.registerResource("price-card", WIDGET_URI, { title: "Dental cost card", mimeType: WIDGET_MIME, description: PRICE_TEXT }, async () =>
    contents(WIDGET_URI, WIDGET_HTML, PRICE_TEXT),
  );
  server.registerResource("plan-card", PLAN_WIDGET_URI, { title: "Dental treatment plan card", mimeType: WIDGET_MIME, description: PLAN_TEXT }, async () =>
    contents(PLAN_WIDGET_URI, PLAN_WIDGET_HTML, PLAN_TEXT),
  );
  // A host keeps the tool descriptor it read when the connector was added or last rescanned: earlier widget URIs
  // must keep resolving (readable, not listed) and serve the current template.
  const earlier = (name: string, template: string, html: string, description: string) =>
    server.registerResource(name, new ResourceTemplate(template, { list: undefined }), { mimeType: WIDGET_MIME, description }, async (uri) =>
      contents(uri.href, html, description),
    );
  earlier("price-card-earlier", "ui://realdentalcosts/price-card-v{version}.html", WIDGET_HTML, PRICE_TEXT);
  earlier("plan-card-earlier", "ui://realdentalcosts/plan-card-v{version}.html", PLAN_WIDGET_HTML, PLAN_TEXT);
  // lot 1 URIs: ui://widget/price-card.html and ui://widget/plan-card.html
  server.registerResource("lot1-cards", new ResourceTemplate("ui://widget/{card}.html", { list: undefined }), { mimeType: WIDGET_MIME, description: PLAN_TEXT }, async (uri, { card }) =>
    card === "price-card" ? contents(uri.href, WIDGET_HTML, PRICE_TEXT) : contents(uri.href, PLAN_WIDGET_HTML, PLAN_TEXT),
  );
}

// ---------------------------------------------------------------------------
// 1. dental_cost_by_state
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_cost_by_state",
  {
    title: "Dental cost by US state",
    description:
      'Use this when the user asks what a dental procedure costs in a given US state (51 incl. DC), or how a state sits next to the US average, for one of 12 procedures: exam and cleaning, filling, deep cleaning, extraction, root canal, crown, implant, All-on-4, dentures, braces, veneer, whitening. Returns the state cash band (low / average / high), the national band, the gap in percent and the state\'s Restorative Cost Index, each with its basis (observed or estimated). Phrasings: "how much is a crown in Ohio without insurance", "what do people in Florida pay for a root canal", "¿cuánto cuesta un implante dental en Texas?", "costo de una limpieza dental en California". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      procedure: procedureEnum,
      state: stateEnum,
      lang: langSchema,
    },
    annotations: ann("Dental cost by US state"),
    ...toolMeta,
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
      api_url: `${API_BASE}/state/${st.code.toLowerCase()}.json`,
      procedure: {
        id: procedure,
        label: procedureLabel(procedure, lang),
        category: proc.cat,
        basis: proc.basis,
        basisNote: BASIS_NOTES[proc.basis]?.[lang],
      },
      state: { code: st.code, name: st.name, restorativeCostIndex: st.index, indexNote: INDEX_NOTE[lang] },
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
    return jsonResult(payload, {
      title: payload.procedure.label,
      location: st.name,
      low,
      avg,
      high,
      avgLabel: lang === "es" ? "Promedio estatal" : "State average",
      rangeNote: BASIS_NOTES[proc.basis]?.[lang] ?? "",
      url: cardUrl(procedure, lang, st.slug),
    });
  },
);

// ---------------------------------------------------------------------------
// 2. dental_cost_by_city
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_cost_by_city",
  {
    title: "Dental implant cost by US city",
    description:
      'Use this when the user names a US city (206 covered) and asks what a dental implant costs there, or how many clinics the figure rests on. Returns the observed city average for a single implant, the clinic count and the state implant band for context (open dataset, DOI 10.5281/zenodo.20819438). Only the implant series is published at city level: other procedures go to dental_cost_by_state. Pass state (2-letter code) to tell apart cities with the same name. Phrasings: "implant cost in San Antonio", "what does a single tooth implant run in Denver", "¿cuánto cuesta un implante en Miami?", "costo de un implante dental en Houston". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      city: z.string().min(1).describe('City name, e.g. "Austin" or "San Diego".'),
      state: stateEnum.optional().describe("Optional 2-letter state code to disambiguate."),
      lang: langSchema,
    },
    annotations: ann("Dental implant cost by US city"),
    ...toolMeta,
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
    const stateImplant = COMPARE_PRICES[st.code]?.implant;
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/us-dental-cost-index/", lang),
      api_url: `${API_BASE}/state/${st.code.toLowerCase()}.json`,
      city: c.name,
      state: { code: st.code, name: st.name },
      clinics: c.clinics,
      currency: "USD",
      costs: {
        Implants: {
          cityAvg: c.costs.Implants.avg,
          stateRange: stateImplant
            ? { low: stateImplant[0], avg: stateImplant[1], high: stateImplant[2] }
            : undefined,
        },
      },
      note:
        lang === "es"
          ? "Solo la serie de implantes se publica a nivel de ciudad (dataset abierto, DOI 10.5281/zenodo.20819438). Las cifras de carillas/brackets por ciudad fueron retiradas en el trabajo de integridad de datos de 2026-07."
          : "Only the implant series is published at city level (open dataset, DOI 10.5281/zenodo.20819438). Per-city veneer/braces figures were retired in the 2026-07 data-integrity work.",
      disclaimer: disclaimer(lang),
    };
    return jsonResult(
      payload,
      stateImplant
        ? {
            title: procedureLabel("implant", lang),
            location: `${c.name}, ${st.code}`,
            low: stateImplant[0],
            avg: c.costs.Implants.avg,
            high: stateImplant[2],
            avgLabel: lang === "es" ? "Promedio de la ciudad" : "City average",
            rangeNote:
              lang === "es"
                ? `Bajo/alto = banda estatal de ${st.name}. ${payload.note}`
                : `Low/high = ${st.name} state band. ${payload.note}`,
            url: cardUrl("implant", lang, st.slug),
          }
        : undefined,
    );
  },
);

// ---------------------------------------------------------------------------
// 4. dental_national_average
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_national_average",
  {
    title: "US national dental cost",
    description:
      'Use this when the user asks what a dental procedure costs in the United States in general, with no state or city, for one of the 12 procedures. Returns the national cash band (low / average / high, mean of the 51 state figures incl. DC), its basis (observed or estimated) and the states at both ends of the range of state averages; cosmetic procedures carry no state variation. Phrasings: "average cost of dentures in the US", "typical US cost for braces", "¿cuánto cuesta una endodoncia en Estados Unidos?", "costo promedio de carillas en EE. UU.". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      procedure: procedureEnum,
      lang: langSchema,
    },
    annotations: ann("US national dental cost"),
    ...toolMeta,
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
    const hasStateVariation = proc.basis !== "national";
    const payload = {
      source: SOURCE,
      reference_url: refUrl("/us-dental-cost-index/", lang),
      api_url: `${API_BASE}/procedure/${PROC_SLUGS[procedure]}.json`,
      procedure: {
        id: procedure,
        label: procedureLabel(procedure, lang),
        category: proc.cat,
        basis: proc.basis,
        basisNote: BASIS_NOTES[proc.basis]?.[lang],
      },
      nationalAverage: {
        low: Math.round(low),
        avg: Math.round(avg),
        high: Math.round(high),
        currency: "USD",
      },
      ...(hasStateVariation
        ? {
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
          }
        : {
            stateVariation:
              lang === "es"
                ? "Sin variación estatal: no existe fuente estatal para este procedimiento estético, todos los estados llevan el rango nacional."
                : "No state variation: no per-state source exists for this cosmetic procedure, every state carries the national range.",
          }),
      disclaimer: disclaimer(lang),
    };
    return jsonResult(payload, {
      title: payload.procedure.label,
      location: lang === "es" ? "Estados Unidos" : "United States",
      low: payload.nationalAverage.low,
      avg: payload.nationalAverage.avg,
      high: payload.nationalAverage.high,
      avgLabel: lang === "es" ? "Promedio nacional" : "National average",
      rangeNote: BASIS_NOTES[proc.basis]?.[lang] ?? "",
      url: cardUrl(procedure, lang),
    });
  },
);

// ---------------------------------------------------------------------------
// 4-7. Treatment-plan checker (observed, sourced amounts only; plan-card widget)
// ---------------------------------------------------------------------------
const planMeta = (invoking: string) => uiMeta(PLAN_WIDGET_URI, invoking, "Sourced figures ready");
const NOTE =
  " Every figure carries its source URL and period; a missing cell returns status no_source_at_this_level with the next level up. Medicaid amounts are what Medicaid paid per claim line (T-MSIS), not what a patient is charged. No personal data (age, ZIP, name, insurer) is requested or stored. " +
  DO_NOT +
  " Observed market research, not a quote, not medical, coding or insurance advice.";

server.registerTool(
  "benchmark_treatment_plan",
  {
    title: "Check a dental treatment plan line by line",
    description:
      'Use this when the user has a treatment plan or quote from a US dentist (CDT codes such as D2740, or procedure names, with quantities and quoted amounts) and wants to know where each line sits. For each line, returns the state cash band (observed or estimated badge) and where the quoted amount falls in it, what Medicaid paid per claim line (T-MSIS p25 / median / p75) and the official Medicaid fee schedule with its age scope (children_only or not_verified: context only), plus the state\'s adult Medicaid rule and numbered sources. quoted_usd is the line total as quoted. Phrasings: "my dentist wrote D2740 and D4341 x4 on the plan, is that in line for Arizona", "go through this dental estimate line by line", "¿es razonable este presupuesto dental en Nevada?", "revisa mi plan de tratamiento con códigos CDT".' +
      NOTE,
    inputSchema: {
      state: stateEnum,
      lines: z
        .array(
          z.object({
            code: z.string().regex(/^[Dd]\d{4}$/).optional().describe('CDT code, e.g. "D2740".'),
            procedure: procedureEnum.optional().describe("Procedure id, when no CDT code is known."),
            qty: z.number().int().min(1).max(32).optional().describe("Quantity (default 1)."),
            quoted_usd: z.number().min(0).max(500000).optional().describe("Quoted amount for the whole line, in US dollars."),
          }),
        )
        .min(1)
        .max(10)
        .describe("Plan lines (1-10; split longer plans). Each line needs a code or a procedure."),
      coverage: z
        .enum(["none", "medicaid_adult", "private", "medicare_advantage", "discount_plan"])
        .default("none")
        .describe("Coverage category only (no plan or insurer name)."),
      lang: langSchema,
    },
    annotations: ann("Check a dental treatment plan line by line"),
    ...planMeta("Checking the plan against sourced references…"),
  },
  async ({ state, lines, coverage, lang }) => {
    if (lines.some((l) => !l.code && !l.procedure)) return errorResult("Each line needs a CDT code or a procedure id.");
    logCall("benchmark_treatment_plan");
    return planResult(benchmarkTreatmentPlan(state, lines, coverage, lang));
  },
);

server.registerTool(
  "medicaid_adult_dental_rules",
  {
    title: "Adult Medicaid dental rule for a US state",
    description:
      'Use this when the user asks whether adult Medicaid covers dental care in a US state, what it covers, or whether it has a yearly dollar limit. Returns the state\'s adult Medicaid dental level with its sources: program summary, annual dollar cap (cap_kind annual_dollar_cap, no_dollar_cap, emergency_only, no_adult_benefit or not_verified, with a verbatim quote), orthodontics and implants policy (verified, silent or not_verified, with a quote), share of dentists billing Medicaid (T-MSIS 2023-2024) and the official fee schedule (URL, effective date, age scope). Phrasings: "does Medicaid cover adult dentures in Georgia", "is there a yearly dental limit on Medicaid in Massachusetts", "¿Medicaid cubre el dentista para adultos en Texas?", "límite anual dental de Medicaid en Nueva York".' +
      NOTE,
    inputSchema: { state: stateEnum, lang: langSchema },
    annotations: ann("Adult Medicaid dental rule for a US state"),
    ...planMeta("Reading the state's Medicaid dental rule…"),
  },
  async ({ state, lang }) => {
    logCall("medicaid_adult_dental_rules");
    return planResult(medicaidAdultDentalRules(state, lang));
  },
);

server.registerTool(
  "medicaid_paid_by_code",
  {
    title: "Medicaid paid per claim line for a CDT code",
    description:
      'Use this when the user asks what Medicaid pays or paid for a CDT dental code (61 codes), nationally or in a US state. Returns the amount paid per claim line from T-MSIS (2018-2024 series, percentiles), the state cell with its rank and the official fee when a state is given (age scope children_only or not_verified: context only), and the national cash band for context. Phrasings: "Medicaid reimbursement for D7140 in Ohio", "what does Medicaid pay a dentist for code D2750", "¿cuánto paga Medicaid por el código D2391?", "reembolso de Medicaid por D1110 en Florida".' +
      NOTE,
    inputSchema: {
      code: z.string().regex(/^[Dd]\d{4}$/).describe('CDT code, e.g. "D2740".'),
      state: stateEnum.optional(),
      lang: langSchema,
    },
    annotations: ann("Medicaid paid per claim line for a CDT code"),
    ...planMeta("Reading Medicaid paid amounts…"),
  },
  async ({ code, state, lang }) => {
    logCall("medicaid_paid_by_code");
    return planResult(medicaidPaidByCode(code, state, lang));
  },
);

server.registerTool(
  "low_cost_dental_options",
  {
    title: "Low-cost dental care options in a US state",
    description:
      'Use this when the user in a US state looks for low-cost or free dental care. Returns verified routes: dental schools (name, city, URL, check date), health centers and dental shortage-area (HPSA) designations, Mission of Mercy events and charity programs, with an optional county for the dental-desert atlas row. Dental-school clinic fees are not published by Real Dental Costs. Phrasings: "where can I get dental work on a tight budget in Columbus", "dental school clinics that see patients in Ohio", "¿dónde hay dentistas gratis en Illinois?", "clínicas dentales de bajo costo en Franklin County".' +
      NOTE,
    inputSchema: {
      state: stateEnum,
      county: z.string().min(2).max(60).optional().describe('County name, e.g. "Franklin".'),
      lang: langSchema,
    },
    annotations: ann("Low-cost dental care options in a US state"),
    ...planMeta("Finding lower-cost options…"),
  },
  async ({ state, county, lang }) => {
    logCall("low_cost_dental_options");
    return planResult(lowCostDentalOptions(state, county, lang));
  },
);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function logCall(tool: string) {
  if (appsSdk) countCall(tool);
}

function planResult(raw: Record<string, unknown>) {
  const payload = tagUtm(raw);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    ...(appsSdk ? { structuredContent: payload } : {}),
  };
}

function jsonResult(raw: Record<string, unknown>, rawCard?: PriceCard) {
  const payload = tagUtm(raw);
  const card = rawCard && tagUtm(rawCard);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(appsSdk
      ? { structuredContent: { ...payload, ...(card ? { card: { ...card, disclaimer: payload.disclaimer } } : {}) } }
      : {}),
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

return server;
}
