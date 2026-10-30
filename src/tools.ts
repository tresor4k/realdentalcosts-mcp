/**
 * Shared tool registration for realdentalcosts-mcp, used by both the stdio
 * binary (src/index.ts) and the Streamable HTTP entry point (src/http.ts).
 *
 * createServer() registers 2 cost tools + 4 treatment-plan tools + 4 lot C1 + 3 lot C2 tools (the modelled
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
  WITHHELD_SERIES,
  WITHHELD_NOTE,
  THIRD_PARTY_TERMS,
} from "./lib/compare-data.js";
import { nationalTriple, PROC_LABELS_ES } from "./lib/pricing.js";
import { WIDGET_URI, WIDGET_MIME, WIDGET_HTML, PLAN_WIDGET_URI, PLAN_WIDGET_HTML } from "./widget.js";
import {
  benchmarkTreatmentPlan,
  bandPosition,
  medicaidAdultDentalRules,
  medicaidPaidByCode,
  lowCostDentalOptions,
  compareStates,
  usDentalSpendingStats,
  canadaDentalCostByProvince,
  cdcpCoverageCheck,
  insuranceOutOfPocket,
  medicareDentalCheck,
  dentalProgramChanges,
  sourceNotes,
  CA_PROVINCE_CODES,
  CA_PROCEDURES,
} from "./lib/rdc.js";

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
    en: "The state AVERAGE is a measured price (crown/veneer/braces/dentures = ASQ360/CareCredit Average Procedural Cost Study 2023-2024, cited on realdentalcosts.com pages, per-state figures not published by this server). The low/high band around it is modelled from national ratios, not an observed percentile.",
    es: "El PROMEDIO estatal es un precio medido (corona/carilla/brackets/dentaduras = estudio ASQ360/CareCredit 2023-2024, citado en las páginas de realdentalcosts.com; este servidor no publica las cifras por estado). La banda low/high alrededor es modelada a partir de ratios nacionales, no un percentil observado.",
  },
  estimated: {
    en: "No collected per-state price exists. The national figure is scaled by the state's Restorative Cost Index (for the single implant, the index base itself: implant = Real Dental Costs' editorial estimate, edition 2026.1 (DOI 10.5281/zenodo.20531728): not collected prices; state ranking validated against ASQ360 (Spearman 0.945), price levels not verified (requalified 2026-10-25, see https://realdentalcosts.com/en/data-corrections/)). Defensible only inside the restorative regime. Treat as an estimate.",
    es: "No existe un precio estatal recopilado. La cifra nacional se escala con el Índice de Coste Restaurador del estado (para el implante unitario, la propia base del índice: implante = estimación editorial de Real Dental Costs, edición 2026.1 (DOI 10.5281/zenodo.20531728): no son precios recopilados; clasificación estatal validada frente a ASQ360 (Spearman 0.945), niveles de precio no verificados (recalificada el 2026-10-25, véase https://realdentalcosts.com/en/data-corrections/)). Solo defendible dentro del régimen restaurador. Trátese como estimación.",
  },
  national: {
    en: "Cosmetic procedure with no per-state source. Cosmetic pricing does not follow restorative geography, so no state variation is invented: every state carries the national range.",
    es: "Procedimiento estético sin fuente estatal. Los precios estéticos no siguen la geografía restauradora, así que no se inventa variación estatal: todos los estados llevan el rango nacional.",
  },
};

const INDEX_NOTE = {
  en: "Restorative Cost Index (U.S. average = 100), built on the state implant series, an editorial estimate (edition 2026.1, not collected prices). Valid ONLY for implant/crown/denture prices — it does not predict orthodontic (braces) or cosmetic (veneer) prices.",
  es: "Índice de Coste Restaurador (promedio de EE. UU. = 100), construido sobre la serie estatal de implantes, una estimación editorial (edición 2026.1, no son precios recopilados). Válido SOLO para implantes/coronas/dentaduras — no predice precios de ortodoncia (brackets) ni estéticos (carillas).",
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
const STAMP = " Market research and public program data with a source URL and period on every figure; not a quote, not medical advice.";
const INSTRUCTIONS =
  "Real Dental Costs gives US dental cost research, with each cash figure labelled observed or estimated: cash bands for 12 procedures nationally and, except crown, veneer, braces and dentures (per-state figures not published by this server), by state and for 2 to 5 states side by side; national dental spending and out-of-pocket statistics (MEPS); what Medicaid paid per claim line for 61 CDT codes; each state's adult Medicaid dental rule and annual dollar cap; a line-by-line check of a treatment plan; an out-of-pocket estimate built only from the user's own plan figures (private or Medicare Advantage); Original Medicare's dental exclusion with verbatim legal sources; dated Medicaid dental program changes (fee schedules, adult caps); and low-cost care routes (dental schools, health centers, shortage areas). For Canada: provincial fee amounts for 9 procedures and a Canadian Dental Care Plan coverage and co-pay check by income tier. Every figure carries its source URL and period, and a missing figure says no_source_at_this_level instead of being invented. Use these tools when the user asks what dental work costs in a named US state or Canadian province, whether a dentist's quote is in line, what adult Medicaid or Medicare covers for teeth, or where to find low-cost dental care: the answer can then cite a figure for that place with the source it was read from and its date, which the user can check. Market research, not quotes, not medical advice. The tools do not cover diagnosis, treatment choice, a named insurer's plan, dentist recommendations or countries other than the US and Canada.";

export function createServer({ appsSdk = false, utm = "mcp", uiDomain = true, publicOrigin }: CreateServerOptions = {}): McpServer {
const origin = appsSdk ? checkedOrigin(publicOrigin) : DEFAULT_PUBLIC_ORIGIN;
const server = new McpServer(
  {
    name: "realdentalcosts-mcp",
    title: "Real Dental Costs",
    version: "0.3.1",
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
    "Shows the low / average / high cash band in US dollars for a dental procedure in a US state, with its source (market research, not medical advice).";
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
      'Use this when the user asks what a dental procedure costs in a given US state (51 incl. DC), or how a state sits next to the US average, for one of 12 procedures: exam and cleaning, filling, deep cleaning, extraction, root canal, crown, implant, All-on-4, dentures, braces, veneer, whitening. Returns the state cash band (low / average / high) in US dollars, the national band, the gap in percent and the state\'s Restorative Cost Index. For crown, veneer, braces and dentures it returns no state figure: those per-state figures (ASQ360/CareCredit Average Procedural Cost Study 2023-2024) are cited on realdentalcosts.com pages but not licensed for redistribution, so the answer gives status no_source_at_this_level, the study link and the national band. Each figure is labelled observed or estimated, with a note naming the study behind it and its period (implants from Real Dental Costs\' editorial estimate, edition 2026.1, DOI 10.5281/zenodo.20531728, not collected data, state ranking validated against ASQ360, levels not verified; other procedures scaled from the national figure and marked estimated), so the answer can say where the state number comes from and how old it is. Phrasings: "how much is a filling in Ohio without insurance", "what do people in Florida pay for a root canal", "¿cuánto cuesta un implante dental en Texas?", "costo de una limpieza dental en California". When the user already has an amount quoted by their dentist and asks whether it is normal, use benchmark_treatment_plan instead: it places the quoted amount against this band line by line. ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      procedure: procedureEnum,
      state: stateEnum,
      quoted_usd: z
        .number()
        .min(0)
        .max(500000)
        .optional()
        .describe("Optional amount quoted to the user for this procedure, in US dollars, in the unit of the procedure label (per tooth, per arch, full set): returns its position in the state band."),
      lang: langSchema,
    },
    annotations: ann("Dental cost by US state"),
    ...toolMeta,
  },
  async ({ procedure, state, quoted_usd, lang }) => {
    const proc = procedureById.get(procedure);
    const st = stateByCode.get(state);
    if (!proc || !st) {
      return errorResult(
        `Unknown procedure or state. Valid procedures: ${PROCEDURE_IDS.join(", ")}. Valid states: ${STATE_CODES.join(", ")}.`,
      );
    }
    const [natLow, natAvg, natHigh] = nationalTriple(procedure);
    if (WITHHELD_SERIES[procedure]) {
      const nat = { low: Math.round(natLow), avg: Math.round(natAvg), high: Math.round(natHigh), currency: "USD" };
      const withheldPayload = {
        source: SOURCE,
        reference_url: refUrl("/compare/", lang),
        api_url: `${API_BASE}/state/${st.code.toLowerCase()}.json`,
        procedure: { id: procedure, label: procedureLabel(procedure, lang), category: proc.cat, basis: proc.basis },
        state: { code: st.code, name: st.name, restorativeCostIndex: st.index, indexNote: INDEX_NOTE[lang] },
        status: "no_source_at_this_level",
        geo: "state",
        withheld: true,
        withheld_note: WITHHELD_NOTE[lang],
        source_url: THIRD_PARTY_TERMS.source_url,
        nationalAverage: nat,
        ...(quoted_usd != null
          ? { quotePosition: { basis: "user_input", quoted_usd, ...bandPosition(quoted_usd, nat.low, nat.high), band: "national low-high (state figures withheld, edges modelled)" } }
          : {}),
        disclaimer: disclaimer(lang),
      };
      return jsonResult(withheldPayload, {
        title: withheldPayload.procedure.label,
        location: lang === "es" ? "Estados Unidos" : "United States",
        low: nat.low,
        avg: nat.avg,
        high: nat.high,
        avgLabel: lang === "es" ? "Promedio nacional" : "National average",
        rangeNote: WITHHELD_NOTE[lang],
        url: cardUrl(procedure, lang, st.slug),
      });
    }
    const [low, avg, high] = COMPARE_PRICES[state][procedure];
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
      ...(quoted_usd != null
        ? { quotePosition: { basis: "user_input", quoted_usd, ...bandPosition(quoted_usd, low, high), band: "state cashPrice low-high (edges modelled)" } }
        : {}),
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
// 4. dental_national_average
// ---------------------------------------------------------------------------
server.registerTool(
  "dental_national_average",
  {
    title: "US national dental cost",
    description:
      'Use this when the user asks what a dental procedure costs in the United States in general, with no state named, for one of the 12 procedures. Returns the national cash band (low / average / high, mean of the 51 state figures incl. DC), its basis (observed or estimated) and the states at both ends of the range of state averages; cosmetic procedures carry no state variation. Phrasings: "average cost of dentures in the US", "typical US cost for braces", "¿cuánto cuesta una endodoncia en Estados Unidos?", "costo promedio de carillas en EE. UU.". ' +
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
    // E-110: for a withheld series, only the 2 state averages API v1 keeps as citations.
    const held = WITHHELD_SERIES[procedure];
    let cheapest = held ? held.cheapest.code : STATE_CODES[0];
    let priciest = held ? held.priciest.code : STATE_CODES[0];
    const stateAvg = (code: string) => (held ? (code === held.cheapest.code ? held.cheapest.avg : held.priciest.avg) : COMPARE_PRICES[code][procedure][1]);
    if (!held)
      for (const code of STATE_CODES) {
        const a = stateAvg(code);
        if (a < stateAvg(cheapest)) cheapest = code;
        if (a > stateAvg(priciest)) priciest = code;
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
              avg: stateAvg(cheapest),
            },
            priciestState: {
              code: priciest,
              name: stateByCode.get(priciest)?.name,
              avg: stateAvg(priciest),
            },
          }
        : {
            stateVariation:
              lang === "es"
                ? "Sin variación estatal: no existe fuente estatal para este procedimiento estético, todos los estados llevan el rango nacional."
                : "No state variation: no per-state source exists for this cosmetic procedure, every state carries the national range.",
          }),
      ...(held ? { third_party_terms: { ...THIRD_PARTY_TERMS, fields: ["cheapestState.avg", "priciestState.avg"] } } : {}),
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
// 4-7. Treatment-plan checker (sourced amounts only; plan-card widget)
// ---------------------------------------------------------------------------
const planMeta = (invoking: string) => uiMeta(PLAN_WIDGET_URI, invoking, "Sourced figures ready");
const NOTE =
  " Every figure carries its source URL and period; a missing cell returns status no_source_at_this_level with the next level up. Medicaid amounts are what Medicaid paid per claim line (T-MSIS), not what a patient is charged. No personal data (age, ZIP, name, insurer) is requested or stored. " +
  DO_NOT +
  " Market research, not a quote, not medical, coding or insurance advice.";

server.registerTool(
  "benchmark_treatment_plan",
  {
    title: "Check a dental treatment plan line by line",
    description:
      'Use this when the user has a treatment plan or quote from a US dentist (CDT codes such as D2740, or procedure names, with quantities and quoted amounts) and wants to know where each line sits. For each line, returns the state cash band (observed or estimated badge) and where the quoted amount falls in it, what Medicaid paid per claim line (T-MSIS p25 / median / p75) and the official Medicaid fee schedule with its age scope (children_only or not_verified: context only), plus the state\'s adult Medicaid rule and numbered sources. quoted_usd is the line total as quoted. Codes billed as parts of one job are summed into a bundle and compared with its band only when the bundle is complete: implant (D6010 + D6056 or D6057 + one crown on the implant: D6058-D6067, D6082-D6084, D6086-D6088, D6094 or D6097), full dentures (D5110 + D5120), veneer (D2962), All-on-4 per arch (D6114 or D6115); a partial bundle returns partial_quote with what the band includes, and a single arch or partial denture gets no verdict; a bridge on implants (D6068-D6079, D6098, D6099, D6120-D6123, D6194, D6195) or a temporary implant crown (D6085) returns no_band. Crown, veneer, braces and dentures have no state band here (per-state figures not licensed for redistribution): those lines and bundles are placed against the national band. No city-level figure is published: passing city returns no_source_at_this_level and the state band applies. Phrasings: "my dentist wrote D2740 and D4341 x4 on the plan, is that in line for Arizona", "go through this dental estimate line by line", "¿es razonable este presupuesto dental en Nevada?", "revisa mi plan de tratamiento con códigos CDT".' +
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
      city: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe('Optional city in the same state, e.g. "Portland". No city-level figure is published: returns status no_source_at_this_level, and the state band applies.'),
      lang: langSchema,
    },
    annotations: ann("Check a dental treatment plan line by line"),
    ...planMeta("Checking the plan against sourced references…"),
  },
  async ({ state, lines, coverage, city, lang }) => {
    if (lines.some((l) => !l.code && !l.procedure)) return errorResult("Each line needs a CDT code or a procedure id.");
    logCall("benchmark_treatment_plan");
    return planResult(benchmarkTreatmentPlan(state, lines, coverage, lang, city));
  },
);

server.registerTool(
  "medicaid_adult_dental_rules",
  {
    title: "Adult Medicaid dental rule for a US state",
    description:
      'Use this when the user asks whether adult Medicaid covers dental care in a US state, what it covers, whether it has a yearly dollar limit or how much that limit is. Returns the state\'s adult Medicaid dental level with its sources. For the annual dollar cap: the amount, the benefit period and a verbatim quote with the URL it was read from (CareQuest Institute coverage checker or state Medicaid documents) and its retrieval date, so the answer can cite a dated figure for that state (cap_kind annual_dollar_cap, no_dollar_cap, emergency_only, no_adult_benefit, or not_verified when no source confirms it). Also: program summary with its check date, orthodontics and implants policy (verified, silent or not_verified, with a quote), share of dentists billing Medicaid (T-MSIS 2023-2024) and the official fee schedule (URL, effective date, age scope). Phrasings: "does Medicaid cover adult dentures in Georgia", "is there a yearly dental limit on Medicaid in Massachusetts", "¿Medicaid cubre el dentista para adultos en Texas?", "límite anual dental de Medicaid en Nueva York".' +
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
      'Use this when the user in a US state looks for low-cost or free dental care, or asks where to get dental work on a tight budget. Returns a list for that state where each route names its source and check date: dental schools with patient clinics (name, city, clinic URL, verified date), the count of HRSA dental shortage-area (HPSA) designations with the date of the HRSA file and the health-center finder link, Mission of Mercy events and charity programs (Dental Lifeline Network and named clinics), with an optional county for the dental-desert atlas row. Dental-school clinic fees are not published by Real Dental Costs. Phrasings: "where can I get dental work on a tight budget in Columbus", "dental school clinics that see patients in Ohio", "¿dónde hay dentistas gratis en Illinois?", "clínicas dentales de bajo costo en Franklin County". Also use it when the user asks whether their county is a dental shortage area or where the community health centers are.' +
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
// 8-11. Lot C1: state side by side, national spending (MEPS), Canada provinces, CDCP co-pay
// ---------------------------------------------------------------------------
const withNotes = (r: Record<string, unknown>) => planResult({ ...r, source_notes: sourceNotes(r) });
const caProvinceEnum = z
  .enum(CA_PROVINCE_CODES as unknown as [string, ...string[]])
  .describe(`Two-letter Canadian province or territory code. One of: ${CA_PROVINCE_CODES.join(", ")}.`);
const caProcedureEnum = z
  .enum(CA_PROCEDURES as unknown as [string, ...string[]])
  .describe(`Procedure key. One of: ${CA_PROCEDURES.join(", ")}.`);

server.registerTool(
  "compare_states",
  {
    title: "Dental cost in 2 to 5 US states side by side",
    description:
      'Use this when the user names two to five US states and asks what one of the 12 procedures (exam and cleaning, filling, deep cleaning, extraction, root canal, crown, implant, All-on-4, dentures, braces, veneer, whitening) costs in each, or in which of them it costs less, for instance before a move or before travelling for care. Returns, for each state, the cash band (low / average / high) in US dollars with its basis badge (observed or estimated), its rank among the 51 state averages and its gap in percent to the national mean, plus the national band. Every row comes from the same series with its source and period, so the states are lined up on one basis; cosmetic procedures carry no state variation. For crown, veneer, braces and dentures each state row returns no_source_at_this_level (ASQ360/CareCredit per-state figures, not licensed for redistribution) and only the national band is given. Phrasings: "line up implant costs in Texas, Florida and Arizona", "fillings in Ohio and Michigan side by side", "¿dónde sale más barato un implante, en Texas o en California?", "compara el costo de una endodoncia en Nueva York y Nueva Jersey". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      procedure: procedureEnum,
      states: z.array(stateEnum).min(2).max(5).describe("2 to 5 two-letter state codes (DC allowed)."),
      lang: langSchema,
    },
    annotations: ann("Dental cost in 2 to 5 US states side by side"),
    ...planMeta("Lining up the states…"),
  },
  async ({ procedure, states, lang }) => {
    const codes = [...new Set(states)];
    if (codes.length < 2) return errorResult("Give 2 to 5 different state codes.");
    logCall("compare_states");
    return withNotes(compareStates(procedure, codes, lang));
  },
);

server.registerTool(
  "us_dental_spending_stats",
  {
    title: "US dental spending and out-of-pocket statistics (MEPS)",
    description:
      'Use this when the user asks how much people in the United States spend on dental care in a year, what share they pay out of pocket, or how many people see a dentist, at national level. Returns survey-weighted national figures from the federal Medical Expenditure Panel Survey (MEPS, AHRQ) for 2023 and 2024: spending per person, out-of-pocket amounts (mean, median, share of spending), total spending, share of people with a dental visit, plus the paired 2023-2024 change for the same persons with its 95% confidence interval. Person-level spending, not the cost of a procedure: procedure costs go to dental_cost_by_state. Phrasings: "how much does a typical American spend at the dentist per year", "what part of dental bills do US households cover themselves", "¿cuánto gasta al año un estadounidense en el dentista?", "gasto de bolsillo en odontología en Estados Unidos". ' +
      DO_NOT +
      STAMP,
    inputSchema: { lang: langSchema },
    annotations: ann("US dental spending and out-of-pocket statistics (MEPS)"),
    ...planMeta("Reading the national spending survey…"),
  },
  async ({ lang }) => {
    logCall("us_dental_spending_stats");
    return withNotes(usDentalSpendingStats(lang));
  },
);

server.registerTool(
  "canada_dental_cost_by_province",
  {
    title: "Dental cost by Canadian province",
    description:
      'Use this when the user asks what a dental procedure costs in a Canadian province, for one of 9 procedures: recall exam, scaling (per unit), one-surface composite filling, simple extraction, molar root canal, complete denture, cast partial denture, ceramic crown, single implant. Returns the amount in Canadian dollars per row from the provincial suggested-fee guide or the listed source, with its source URL and an estimated badge where the dataset marks one (open dataset, DOI 10.5281/zenodo.20744781, 10 provinces; territories return no_source_at_this_level). Rows under a data-quality review are withheld with their issue number. Phrasings: "what does a crown run in Alberta", "root canal fees in Nova Scotia", "¿cuánto cuesta una limpieza dental en Ontario?", "costo de un implante dental en Columbia Británica". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      province: caProvinceEnum,
      procedure: caProcedureEnum.optional().describe("Optional procedure key; all 9 when omitted."),
      lang: langSchema,
    },
    annotations: ann("Dental cost by Canadian province"),
    ...planMeta("Reading the provincial fee data…"),
  },
  async ({ province, procedure, lang }) => {
    logCall("canada_dental_cost_by_province");
    return withNotes(canadaDentalCostByProvince(province, procedure, lang));
  },
);

server.registerTool(
  "cdcp_coverage_check",
  {
    title: "Canadian Dental Care Plan coverage and co-pay check",
    description:
      'Use this when the user asks whether the Canadian Dental Care Plan (CDCP) covers a dental procedure and what share they would pay, given an adjusted family net income and a province. Returns the CDCP income tier (share paid by the plan and co-pay percentage), the coverage status and pre-authorization rule of each of the 9 procedures from the federal plan guide, and, when a procedure is given, an estimated co-pay in Canadian dollars on the provincial fee reference (badge estimated; the plan pays on its own fee grid). Only an income figure and a province are asked: no name, SIN, date of birth or insurer. Phrasings: "would CDCP pay for a crown with a family net income of 75k in Ontario", "my share for a filling under the federal dental plan in Manitoba", "¿el plan dental canadiense cubre una endodoncia si la familia gana 72 000 al año?", "copago del CDCP para una extracción en Québec". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      adjusted_family_net_income_cad: z
        .number()
        .min(0)
        .max(10_000_000)
        .describe("Adjusted family net income in Canadian dollars (the tax-return figure). No other personal data."),
      province: caProvinceEnum,
      procedure: caProcedureEnum.optional().describe("Optional procedure key for an estimated co-pay."),
      lang: langSchema,
    },
    annotations: ann("Canadian Dental Care Plan coverage and co-pay check"),
    ...planMeta("Checking the dental care plan rules…"),
  },
  async ({ adjusted_family_net_income_cad, province, procedure, lang }) => {
    logCall("cdcp_coverage_check");
    return withNotes(cdcpCoverageCheck(adjusted_family_net_income_cad, province, procedure, lang));
  },
);

// ---------------------------------------------------------------------------
// 12-14. Lot C2: out-of-pocket from the user's own plan figures, Medicare dental rule, dated program changes
// ---------------------------------------------------------------------------
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

server.registerTool(
  "insurance_out_of_pocket",
  {
    title: "Out-of-pocket estimate from your own dental plan figures",
    description:
      'Use this when the user has a private dental plan or a Medicare Advantage plan with dental benefits, knows its figures (deductible left, annual maximum left, coinsurance per procedure or per class), and asks what they would still pay for dental work in a US state. Every plan parameter comes from the user; the tool assumes none and names no insurer. Returns, per line, the state cash band (observed or estimated badge; the national band for crown, veneer, braces and dentures, whose per-state figures are not published here) and an estimated split (deductible, plan share, user share) on the low, average and high of the band, with the formula written out; a line missing a parameter is not computed and says which one. Phrasings: "my plan has 50 dollars of deductible left and 1,200 of annual max, coinsurance 50% on crowns, what would a crown in Ohio leave me to pay", "estimate my share for a root canal and a crown with my Medicare Advantage dental benefit in Florida", "¿cuánto me tocaría pagar por un implante con mi seguro dental si me quedan 800 del máximo anual?", "¿cuál sería mi parte de una endodoncia con coaseguro del 20% en Texas?". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      state: stateEnum,
      coverage: z.enum(["private", "medicare_advantage"]).describe("Coverage category only (no plan or insurer name)."),
      lines: z
        .array(
          z.object({
            procedure: procedureEnum,
            qty: z.number().int().min(1).max(32).optional().describe("Quantity (default 1)."),
            coinsurance_pct: z.number().min(0).max(100).optional().describe("Share the user pays after the deductible for this line, in percent, as read in the plan document."),
            class: z.string().min(1).max(40).optional().describe("The user's own class label for this line (a key of coinsurance_by_class). The tool assigns no class."),
            deductible_applies: z.boolean().optional().describe("false if the user's plan exempts this line from the deductible (default true)."),
          }),
        )
        .min(1)
        .max(10)
        .describe("Lines in the order the user expects them to be billed (1-10)."),
      deductible_remaining_usd: z.number().min(0).max(100000).optional().describe("Deductible still to meet this benefit year, in US dollars (0 if met). Required to compute."),
      annual_max_remaining_usd: z.number().min(0).max(1000000).optional().describe("Annual maximum still available this benefit year, in US dollars. Required unless no_annual_maximum is true."),
      no_annual_maximum: z.boolean().optional().describe("true only if the user's plan document states no annual maximum."),
      coinsurance_by_class: z
        .record(z.string().min(1).max(40), z.number().min(0).max(100))
        .optional()
        .describe("The user's coinsurance in percent per class label they provide, e.g. their plan's own class names."),
      lang: langSchema,
    },
    annotations: ann("Out-of-pocket estimate from your own dental plan figures"),
    ...planMeta("Applying your plan figures to the cash band…"),
  },
  async ({ state, coverage, lines, deductible_remaining_usd, annual_max_remaining_usd, no_annual_maximum, coinsurance_by_class, lang }) => {
    logCall("insurance_out_of_pocket");
    return withNotes(
      insuranceOutOfPocket(state, lines, { coverage, deductible_remaining_usd, annual_max_remaining_usd, no_annual_maximum, coinsurance_by_class }, lang),
    );
  },
);

server.registerTool(
  "medicare_dental_check",
  {
    title: "Does Medicare cover dental care?",
    description:
      'Use this when the user asks whether Medicare covers dental work (cleanings, fillings, extractions, dentures, implants), what Original Medicare (Part A or Part B) does for teeth, or in which cases Medicare pays toward dental care. Returns the rule as verbatim legal text, each quote with its source URL and retrieval date: the statutory exclusion (Social Security Act 1862(a)(12)), the regulation (42 CFR 411.15(i)) and the medicare.gov coverage page with its narrow exceptions (dental care tied to a hospital admission or to certain covered medical treatments), plus the dated Medicare Advantage open enrollment period, so the answer can quote the rule itself. Medicare Advantage plans for 2027 and their dental limits plan by plan are not yet tracked; for a plan whose figures the user knows, it points to insurance_out_of_pocket. Phrasings: "will Medicare pay for my dentures", "is a tooth extraction covered by Part B", "¿Medicare cubre los implantes dentales?", "¿Medicare paga la limpieza dental?". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      coverage: z
        .enum(["original_medicare", "medicare_advantage", "not_sure"])
        .default("not_sure")
        .describe("The user's Medicare coverage category, if known (no plan name)."),
      lang: langSchema,
    },
    annotations: ann("Does Medicare cover dental care?"),
    ...planMeta("Reading the Medicare dental rule…"),
  },
  async ({ coverage, lang }) => {
    logCall("medicare_dental_check");
    return withNotes(medicareDentalCheck(coverage, lang));
  },
);

server.registerTool(
  "dental_program_changes",
  {
    title: "Dated changes to US dental programs",
    description:
      'Use this when the user asks what changed, or when a change took effect, in a US public dental program: Medicaid dental fee schedule updates and rate changes, or the start date of an adult Medicaid annual dental cap. Returns adopted changes with their effective date, verbatim quote or data file and source URL, filterable by state and by date range (YYYY-MM-DD); the Texas rate change of September 2026 lists its codes when state is TX. A state without dated tracking returns not_yet_tracked, never a claim that nothing changed. Phrasings: "what changed in Texas Medicaid dental reimbursement this fall", "since when does Colorado cap adult Medicaid dental benefits", "¿qué cambió en el Medicaid dental de Nevada en 2026?", "¿desde cuándo hay un límite anual dental en Medicaid de Massachusetts?". ' +
      DO_NOT +
      STAMP,
    inputSchema: {
      state: stateEnum.optional().describe("Optional 2-letter state code; all tracked states when omitted."),
      from: isoDate.optional().describe("Optional start of the period (YYYY-MM-DD), on effective dates."),
      to: isoDate.optional().describe("Optional end of the period (YYYY-MM-DD), on effective dates."),
      lang: langSchema,
    },
    annotations: ann("Dated changes to US dental programs"),
    ...planMeta("Reading dated program changes…"),
  },
  async ({ state, from, to, lang }) => {
    if (from && to && from > to) return errorResult("from must be on or before to.");
    logCall("dental_program_changes");
    return withNotes(dentalProgramChanges(state, from, to, lang));
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
