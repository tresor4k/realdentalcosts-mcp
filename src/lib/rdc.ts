/**
 * Treatment-plan checker logic (ChatGPT app / Claude connector, lot 1).
 *
 * Reads ONLY src/data/rdc/*.json (copied verbatim from the published Real Dental
 * Costs API v1 and open datasets by scripts/sync-data.mjs). Rules:
 * - every number returned sits in an object carrying `source_url` + `period` or
 *   `effective_date`, or in an object marked `basis: "user_input"`;
 * - a missing cell returns `status: "no_source_at_this_level"` plus the next level
 *   up, never a number;
 * - modelled figures carry the `estimated` badge;
 * - Medicaid amounts are "paid per claim line (T-MSIS)", never a consumer price.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPARE_PRICES, WITHHELD_SERIES, WITHHELD_NOTE, THIRD_PARTY_TERMS, NATIONAL_SOURCE } from "./compare-data.js";
import { nationalTriple, PROC_LABELS_ES } from "./pricing.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
export type Lang = "en" | "es";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "rdc");
let cache: Record<string, Any> | null = null;
function D(): Record<string, Any> {
  if (!cache) {
    cache = {};
    for (const f of ["medicaid", "states", "procedures", "rules", "options", "chains", "meps", "canada", "programs", "manifest"])
      cache[f] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${f}.json`), "utf8"));
  }
  return cache;
}

const SITE = "https://realdentalcosts.com";
// utm_source=mcp (stdio/npm) is rewritten per host by tools.ts: chatgpt on /mcp, claude on /claude.
export const UTM = "utm_source=mcp&utm_medium=mcp";
const ACC_CSV = `${SITE}/data/us-dental-insurance-acceptance-by-state-2026.csv`;
const ATLAS_CSV = `${SITE}/data/us-dental-deserts-atlas-2026.csv`;
const FREE_CSV = `${SITE}/data/us-free-dental-programs-by-state-2026.csv`;
const apiState = (st: string) => `${SITE}/api/v1/state/${st.toLowerCase()}.json`;
const apiMedicaid = (code: string) => `${SITE}/api/v1/medicaid/${code}.json`;

const T = {
  tmsis: { en: "paid per claim line (T-MSIS)", es: "pagado por línea de factura (T-MSIS)" },
  fee: {
    en: "official Medicaid fee-for-service schedule amount (a published rate, not what was paid)",
    es: "importe del baremo oficial de pago por servicio de Medicaid (tarifa publicada, no lo pagado)",
  },
  disclaimer: {
    en: "Pricing and market research by Real Dental Costs, not medical, dental, coding or insurance advice. Every figure is a published amount with its source; none is a negotiation target.",
    es: "Investigación de precios y de mercado de Real Dental Costs, no es asesoramiento médico, dental, de codificación ni de seguros. Cada cifra es un importe publicado con su fuente; ninguna es un objetivo de negociación.",
  },
  schools: {
    en: "Dental-school clinic prices are not published by Real Dental Costs: ask the clinic for its fee list.",
    es: "Real Dental Costs no publica los precios de las clínicas de escuelas dentales: pida su lista de tarifas.",
  },
  notCovered: {
    en: "This code is not among the 61 CDT codes Real Dental Costs publishes: no figure is given.",
    es: "Este código no está entre los 61 códigos CDT que publica Real Dental Costs: no se da ninguna cifra.",
  },
} as const;

const COVERAGE_NOTE: Record<string, { en: string; es: string }> = {
  none: {
    en: "No coverage: the cash band is the relevant reference.",
    es: "Sin cobertura: la banda de precio en efectivo es la referencia.",
  },
  medicaid_adult: {
    en: "Adult Medicaid: see the state rule block. Fee schedules marked children_only do not describe adult coverage.",
    es: "Medicaid adulto: vea el bloque de reglas del estado. Los baremos marcados children_only no describen la cobertura adulta.",
  },
  private: {
    en: "Private plan: Real Dental Costs has no source for plan-specific allowed amounts; the figures below are not what your plan pays.",
    es: "Plan privado: Real Dental Costs no tiene fuente de importes permitidos por plan; las cifras no son lo que paga su plan.",
  },
  medicare_advantage: {
    en: "Medicare Advantage: dental benefits vary by plan and Real Dental Costs publishes no plan-level source; the figures below are not plan amounts.",
    es: "Medicare Advantage: los beneficios dentales varían por plan y Real Dental Costs no publica una fuente por plan; las cifras no son importes del plan.",
  },
  discount_plan: {
    en: "Discount plan: Real Dental Costs publishes no source for discounted fee lists; compare the quote with the cash band only.",
    es: "Plan de descuento: Real Dental Costs no publica fuente de listas con descuento; compare el presupuesto solo con la banda en efectivo.",
  },
};

/** Codes whose unit matches the RDC cash band they map to (per tooth / per quadrant / full case). */
const UNIT_COMPARABLE = new Set([
  "D2330", "D2391", "D2392", "D2393",
  "D2740", "D2750", "D2751", "D2752", "D2790",
  "D3310", "D3320", "D3330",
  "D4341",
  "D7140", "D7210", "D7220", "D7230", "D7240",
  "D8080", "D8090",
]);

/** Chain published "starting at" prices shown next to matching lines (chain's own service names). */
const CHAIN_FOR: Record<string, string[]> = {
  D5110: ["economyNew", "premiumNew"],
  D5120: ["economyNew", "premiumNew"],
  dentures: ["economyNew", "premiumNew"],
  D7140: ["routineExtraction"],
  extraction: ["routineExtraction"],
};

export const STATE_CODES = (): string[] => Object.keys(D().states).sort();
export const PROCEDURE_IDS = (): string[] => Object.keys(D().procedures).sort();
export const MEDICAID_CODES = (): string[] => Object.keys(D().medicaid.codes).sort();
export const manifest = (): Any => D().manifest;

const day = (iso: string) => String(iso).slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

function stateHubUrl(st: string): string {
  const slug = D().options[st]?.slug;
  return slug && st !== "DC" ? `${SITE}/en/${slug}/?${UTM}` : `${SITE}/en/free-dental-care-by-state/?${UTM}`;
}

// ---------------------------------------------------------------------------
// building blocks
// ---------------------------------------------------------------------------
function nationalPaid(code: string, lang: Lang, withSeries = false): Any {
  const c = D().medicaid.codes[code];
  const { by_year, ...latest } = c.national;
  return {
    status: "ok",
    geo: "national",
    label: T.tmsis[lang],
    ...latest,
    ...(withSeries ? { by_year } : {}),
    source: D().medicaid.meta.source,
    source_url: D().medicaid.meta.source_url,
    api_url: apiMedicaid(code),
  };
}

export const NOMINAL = "nominal_amounts_suspected";
const NOMINAL_REASON =
  "claim lines in this state carry nominal or zero paid amounts (managed-care encounter records); see the official fee schedule instead";
const NON_NPI_CAVEAT = "provider identifiers are not NPIs; amounts may be understated";

function medicaidPaid(code: string, st: string, lang: Lang, withSeries = false, compact = false): Any {
  const s = D().medicaid.codes[code].states[st];
  if (!s?.latest) {
    return {
      status: "no_source_at_this_level",
      geo: "state",
      state: st,
      reason: s
        ? "No published state cell for the latest period (HHS suppresses cells under 12 claim lines or 12 patients)."
        : "No published state cell for this code (HHS suppression or no claims).",
      ...(withSeries && s ? { earlier_years: Object.keys(s.by_year) } : {}),
      next_level: nationalPaid(code, lang, withSeries),
    };
  }
  if (s.quality_flag === NOMINAL) {
    // Managed-care encounter records carry nominal/zero paid amounts: no dollar figure is shown.
    return {
      status: "amounts_not_reliable",
      geo: "state",
      state: st,
      label: T.tmsis[lang],
      reason: NOMINAL_REASON,
      quality_flag: s.quality_flag,
      ...(s.quality_evidence && !compact ? { quality_evidence: s.quality_evidence } : {}),
      period: s.latest.period,
      lines: s.latest.lines,
      n_providers: s.latest.n_providers,
      source_url: D().medicaid.meta.source_url,
    };
  }
  return {
    status: "ok",
    geo: "state",
    state: st,
    label: T.tmsis[lang],
    ...s.latest,
    ...(withSeries ? { by_year: s.by_year } : {}),
    quality_flag: s.quality_flag,
    ...(s.quality_flag === "non_npi_identifiers" ? { caveat: NON_NPI_CAVEAT } : {}),
    ...(s.quality_evidence && !compact ? { quality_evidence: s.quality_evidence } : {}),
    confidence: s.confidence,
    ...(compact ? {} : { source: D().medicaid.meta.source, api_url: apiMedicaid(code) }),
    source_url: D().medicaid.meta.source_url,
  };
}

// Upstream only ever flags "children"; any other schedule has an unknown age scope (E-101: the TX schedule read for
// D2740 covers children). An unknown scope is reported as not_verified, and an official fee is context only: it is
// never the reference of a quote's position (position() uses the cash band alone).
function scheduleScope(st: string): "children_only" | "not_verified" {
  return D().rules[st]?.schedule?.schedule_scope === "children_only" ? "children_only" : "not_verified";
}

function feeSchedule(code: string, st: string, lang: Lang, compact = false): Any {
  const f = D().medicaid.codes[code].states[st]?.official_fee;
  if (!f) {
    return {
      status: "no_source_at_this_level",
      geo: "state",
      state: st,
      next_level: { geo: "national", status: "no_source_at_this_level", reason: "There is no national Medicaid fee schedule." },
    };
  }
  return {
    status: "ok",
    ...(compact ? {} : { label: T.fee[lang] }),
    fee_usd: f.fee_usd,
    ...(f.fee_alt_usd != null ? { fee_alt_usd: f.fee_alt_usd, fee_alt_label: f.fee_alt_label } : {}),
    effective_date: f.effective_date ?? null,
    // Some schedules state no effective date: the only date the source gives is the ADA index listing.
    ...(f.effective_date ? {} : { period: `no effective date in the source; listed in the ADA Medicaid fee-schedule index as of ${f.ada_index_as_of}`, badge: "undated_schedule" }),
    schedule_scope: scheduleScope(st),
    reference_use: "context_only",
    ...(f.column_note && !compact ? { column_note: f.column_note } : {}),
    source_url: f.source_url,
    ...(compact ? {} : { api_url: apiMedicaid(code) }),
  };
}

function badges(basis: string) {
  return basis === "observed"
    ? { avg_usd: "observed", low_usd: "estimated", high_usd: "estimated" }
    : { avg_usd: "estimated", low_usd: "estimated", high_usd: "estimated" };
}

function position(perUnit: number | null, low: number, high: number, comparable: boolean): Any {
  if (perUnit == null) return { verdict: "no_quote" };
  if (!comparable) return { verdict: "not_comparable_unit", reason: "The quoted code is not priced in the same unit as this band." };
  const base = { quoted_per_unit_usd: perUnit, badge: "estimated" };
  if (perUnit > high) return { verdict: "above_high_by_pct", pct: Math.round(((perUnit - high) / high) * 1000) / 10, ...base };
  if (perUnit < low) return { verdict: "below_low_by_pct", pct: Math.round(((low - perUnit) / low) * 1000) / 10, ...base };
  return { verdict: "within_band", ...base };
}

function cashBand(procId: string, st: string, perUnit: number | null, comparable: boolean): Any {
  const p = D().states[st].procedures[procId];
  const nat = D().procedures[procId];
  const withheld = WITHHELD_SERIES[procId] != null;
  if (p.basis === "national" || withheld) {
    const pos = position(perUnit, nat.national.low_usd, nat.national.high_usd, comparable);
    return {
      status: "no_source_at_this_level",
      geo: "state",
      ...(withheld ? { procedure_id: procId, basis: p.basis, withheld: true, source_url: THIRD_PARTY_TERMS.source_url } : {}),
      reason: withheld ? "Per-state figures not licensed for redistribution: see source_url." : "No per-state source exists for this procedure.",
      next_level: {
        status: "ok",
        geo: "national",
        procedure_id: procId,
        label: nat.label,
        basis: nat.basis,
        low_usd: nat.national.low_usd,
        avg_usd: nat.national.avg_usd,
        high_usd: nat.national.high_usd,
        badges: badges(nat.basis),
        position: pos.verdict === "no_quote" ? pos : { ...pos, verdict: "no_state_source_national_used", vs_national: pos.verdict },
        source: withheld ? NATIONAL_SOURCE : nat.provenance.source,
        source_url: withheld ? nat.national.source : nat.provenance.source_url,
        period: nat.provenance.period,
      },
    };
  }
  return {
    status: "ok",
    geo: "state",
    procedure_id: procId,
    label: p.label,
    basis: p.basis,
    low_usd: p.low_usd,
    avg_usd: p.avg_usd,
    high_usd: p.high_usd,
    badges: badges(p.basis),
    position: position(perUnit, p.low_usd, p.high_usd, comparable),
    source: p.provenance.source,
    source_url: p.provenance.source_url,
    period: p.provenance.period,
    confidence: p.provenance.confidence,
  };
}

function chainPrices(key: string, st: string): Any | undefined {
  const keys = CHAIN_FOR[key];
  if (!keys) return undefined;
  const ch = D().chains["affordable-dentures-implants"];
  const s = ch.byState[st];
  if (!s) return { status: "no_source_at_this_level", geo: "state", chain: ch.chain, reason: "The chain lists no office in this state." };
  const svc: Record<string, string> = { economyNew: "economy", premiumNew: "premium", routineExtraction: "routineExtraction" };
  return {
    status: "ok",
    chain: ch.chain,
    kind: "published 'starting at' list price on the chain's office pages",
    offices: s.offices,
    items: keys
      .filter((k) => s[k])
      .map((k) => ({ service: ch.services[svc[k]].label, unit: ch.services[svc[k]].unit ?? "per service", ...s[k] })),
    source_url: ch.api_url,
    period: `crawled ${day(ch.crawled_at)}`,
  };
}

const LEVEL_MAP: Record<string, string> = { comprehensive: "extensive" };

/**
 * Codes billed as parts of one job priced by a single Real Dental Costs band. The band is compared
 * with the SUM of the lines, and only when every group is on the plan (same quantity in each group).
 * Labels are plain-language descriptions, not ADA descriptors.
 */
const IMPLANT_CROWNS = ["D6058", "D6059", "D6060", "D6061", "D6062", "D6063", "D6064", "D6065", "D6066", "D6067", "D6082", "D6083", "D6084", "D6086", "D6087", "D6088", "D6094", "D6097"];
const IMPLANT_BRIDGE = ["D6068", "D6069", "D6070", "D6071", "D6072", "D6073", "D6074", "D6075", "D6076", "D6077", "D6078", "D6079", "D6098", "D6099", "D6120", "D6121", "D6122", "D6123", "D6194", "D6195"];
const CDT_BUNDLES: Record<string, { groups: string[][]; extra?: string[]; partial?: string[]; includes: string; noBand?: string }> = {
  implant: {
    groups: [["D6010"], ["D6056", "D6057"], IMPLANT_CROWNS],
    includes: "The single-implant band covers the whole tooth: implant body placement (D6010) + abutment (D6056 or D6057) + one crown on the implant (D6058-D6067, D6082-D6084, D6086-D6088, D6094 or D6097).",
  },
  implant_bridge: {
    groups: [IMPLANT_BRIDGE],
    includes: "The single-implant band prices one tooth (implant + abutment + one crown), not a bridge or a multi-tooth prosthesis on implants.",
    noBand: "No Real Dental Costs band covers a bridge or multi-tooth fixed prosthesis on implants: no verdict for these lines or for the implant lines quoted with them.",
  },
  implant_interim_crown: {
    groups: [["D6085"]],
    includes: "The single-implant band prices the final crown, not a temporary one.",
    noBand: "No Real Dental Costs band covers a temporary crown on an implant: no verdict for this line.",
  },
  dentures: {
    groups: [["D5110"], ["D5120"]],
    partial: ["D5211", "D5212", "D5213", "D5214"],
    includes: "The dentures band is a full set: complete upper (D5110) + complete lower (D5120) denture.",
  },
  veneer: { groups: [["D2962"]], includes: "The veneer band is per tooth (D2962)." },
  allon4: {
    groups: [["D6114", "D6115"]],
    extra: ["D6010", "D6056", "D6057"],
    includes: "The All-on-4 band is per arch: one full-arch fixed denture on implants (D6114 upper, D6115 lower); implant (D6010) and abutment lines on the same plan are added to the arch total.",
  },
};
const BUNDLE_LABEL: Record<string, string> = {
  D6010: "implant body placement (surgery)",
  D6056: "prefabricated abutment",
  D6057: "custom abutment",
  D6058: "abutment-supported ceramic crown",
  D6065: "implant-supported ceramic crown",
  D6066: "implant-supported crown, porcelain fused to metal",
  D6067: "implant-supported crown, metal",
  D6059: "abutment-supported crown, porcelain fused to high-noble metal",
  D6060: "abutment-supported crown, porcelain fused to base metal",
  D6061: "abutment-supported crown, porcelain fused to noble metal",
  D6062: "abutment-supported crown, high-noble metal",
  D6063: "abutment-supported crown, base metal",
  D6064: "abutment-supported crown, noble metal",
  D6082: "implant-supported crown, porcelain fused to base metal",
  D6083: "implant-supported crown, porcelain fused to noble metal",
  D6084: "implant-supported crown, porcelain fused to titanium",
  D6086: "implant-supported crown, base metal",
  D6087: "implant-supported crown, noble metal",
  D6088: "implant-supported crown, titanium",
  D6094: "abutment-supported crown, titanium",
  D6097: "abutment-supported crown, porcelain fused to titanium",
  D6085: "temporary crown on an implant",
  ...Object.fromEntries(IMPLANT_BRIDGE.map((c) => [c, "part of a bridge or multi-tooth fixed prosthesis on implants"])),
  D2962: "porcelain veneer",
  D6114: "full-arch fixed denture on implants, upper",
  D6115: "full-arch fixed denture on implants, lower",
};
const VERDICT: Record<string, string> = { above_high_by_pct: "above_band", below_low_by_pct: "below_band", within_band: "within_band" };

/** Where an amount sits in a [low, high] band: above_band / within_band / below_band (+ % outside the edge). */
export function bandPosition(amount: number, low: number, high: number): Any {
  if (amount > high) return { verdict: "above_band", pct_above_high: Math.round(((amount - high) / high) * 1000) / 10 };
  if (amount < low) return { verdict: "below_band", pct_below_low: Math.round(((low - amount) / low) * 1000) / 10 };
  return { verdict: "within_band" };
}

function bundles(st: string, lines: PlanLine[]): Any[] {
  const coded = lines.filter((l) => l.code).map((l) => ({ ...l, code: (l.code as string).toUpperCase(), qty: l.qty ?? 1 }));
  const out: Any[] = [];
  for (const [id, b] of Object.entries(CDT_BUNDLES)) {
    const inGroups = coded.filter((l) => b.groups.some((g) => g.includes(l.code)));
    const partial = coded.filter((l) => b.partial?.includes(l.code));
    if (!inGroups.length && !partial.length) continue;
    if (id === "implant" && coded.some((l) => CDT_BUNDLES.allon4.groups[0].includes(l.code))) continue; // counted per arch
    // implant + abutment lines quoted for a bridge, with no single crown: the bridge entry carries the status
    if (id === "implant" && coded.some((l) => IMPLANT_BRIDGE.includes(l.code)) && !coded.some((l) => IMPLANT_CROWNS.includes(l.code))) continue;
    const qtys = b.groups.map((g) => inGroups.filter((l) => g.includes(l.code)).reduce((n, l) => n + l.qty, 0));
    const missing = b.groups.filter((_, i) => !qtys[i]).map((g) => g.join(" or "));
    const base: Any = { bundle: id, codes: [...inGroups, ...partial].map((l) => l.code), band_includes: b.includes };
    if (b.noBand) {
      out.push({ ...base, status: "no_band", verdict: "none", reason: b.noBand });
      continue;
    }
    if (id === "dentures" && (missing.length || partial.length)) {
      out.push({ ...base, status: "no_per_arch_band", verdict: "none", reason: "No per-arch band published: the dentures band is a full set (both arches), so a single arch or a partial denture gets no verdict." });
      continue;
    }
    if (missing.length) {
      out.push({ ...base, status: "partial_quote", verdict: "none", missing, reason: "The quote covers only part of what the band includes: no verdict until every part is on the plan.", cash_band: cashBand(id, st, null, true) });
      continue;
    }
    if (qtys.some((q) => q !== qtys[0])) {
      out.push({ ...base, status: "not_comparable_unit", verdict: "none", reason: "The parts are quoted in different quantities: split the plan per tooth or per arch." });
      continue;
    }
    const all = [...inGroups, ...coded.filter((l) => b.extra?.includes(l.code))];
    const quotedAll = all.every((l) => l.quoted_usd != null);
    const total = quotedAll ? round2(all.reduce((n, l) => n + (l.quoted_usd as number), 0)) : null;
    const units = qtys[0];
    const band = cashBand(id, st, total == null ? null : round2(total / units), true);
    const pos = band.position ?? band.next_level?.position;
    const v = band.position ? pos.verdict : pos.vs_national ?? pos.verdict;
    out.push({
      ...base,
      codes: all.map((l) => l.code),
      status: "complete",
      ...(total != null ? { quote: { basis: "user_input", bundle_total_usd: total, units, per_unit_usd: round2(total / units) } } : {}),
      verdict: total == null ? "no_quote" : VERDICT[v] ?? v,
      cash_band: band,
    });
  }
  return out;
}

function cityReference(city: string): Any {
  return {
    status: "no_source_at_this_level",
    geo: "city",
    city,
    reason: "Real Dental Costs publishes no city-level figure: city implant prices and clinic counts were withdrawn on October 25, 2026 (https://realdentalcosts.com/en/data-corrections/). The state band applies.",
  };
}

// ---------------------------------------------------------------------------
// tool 2: medicaid_adult_dental_rules
// ---------------------------------------------------------------------------
export function medicaidAdultDentalRules(st: string, lang: Lang): Any {
  const d = D();
  const s = d.states[st];
  const r = d.rules[st];
  const level = s.medicaid.adult_dental_coverage_level;
  const progLevel = r.program?.level ?? null;
  const pol = (p: Any) =>
    p
      ? { ...p, period: p.source_date ?? `consulted ${r.policy_consulted}` }
      : { status: "not_verified" };
  return {
    tool: "medicaid_adult_dental_rules",
    state: { code: st, name: s.name },
    level: {
      value: level,
      source_url: s.medicaid.source ?? ACC_CSV,
      api_url: apiState(st),
      as_of: day(s.generated_at),
    },
    program_summary: r.program
      ? {
          level: progLevel,
          level_label: r.program.level_label,
          summary: r.program.summary,
          checked_at: r.program.checked_at,
          source: r.program.source,
          source_url: FREE_CSV,
        }
      : { status: "no_source_at_this_level", geo: "state" },
    ...(progLevel && (LEVEL_MAP[progLevel] ?? progLevel) !== level
      ? { sources_disagree: `API v1 level "${level}" vs program summary level "${progLevel}" (two RDC sources; both shown, neither recomputed)` }
      : {}),
    annual_cap:
      r.cap && r.cap.cap_kind !== "not_verified"
        ? { status: "ok", ...r.cap }
        : {
            status: "not_verified",
            cap_kind: "not_verified",
            geo: "state",
            field: "adult annual dental cap",
            ...(r.cap?.note ? { note: r.cap.note } : {}),
            next_level: { geo: "national", status: "no_source_at_this_level", reason: "No national cap exists; the cap must come from the state's own documents." },
          },
    orthodontics: pol(r.ortho),
    implants: pol(r.implants),
    dentists_billing_medicaid:
      r.billing.pct_dentists_billing_medicaid != null
        ? {
            status: "ok",
            pct: r.billing.pct_dentists_billing_medicaid,
            dentists_billing: r.billing.dentists_billing_medicaid,
            dentists_active_nppes: r.billing.dentists_active_nppes,
            quality_flag: r.billing.quality_flag,
            measure: "dentists with published T-MSIS claim lines 2023-2024 / active dentists in NPPES (Aug 2026)",
            source_url: ATLAS_CSV,
            period: "2023-2024",
          }
        : { status: "no_source_at_this_level", geo: "state", next_level: { geo: "national", status: "no_source_at_this_level" } },
    fee_schedule: r.schedule
      ? {
          status: "ok",
          source_url: r.schedule.source_url,
          effective_date: r.schedule.effective_date,
          schedule_scope: scheduleScope(st),
          ...(r.schedule.column_note ? { column_note: r.schedule.column_note } : {}),
        }
      : { status: "no_source_at_this_level", geo: "state" },
    links: { state: stateHubUrl(st), methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

// ---------------------------------------------------------------------------
// tool 3: medicaid_paid_by_code
// ---------------------------------------------------------------------------
export function medicaidPaidByCode(codeIn: string, st: string | undefined, lang: Lang): Any {
  const code = codeIn.toUpperCase();
  const c = D().medicaid.codes[code];
  if (!c) return { tool: "medicaid_paid_by_code", code, status: "not_covered", message: T.notCovered[lang], disclaimer: T.disclaimer[lang] };
  const cash = c.cash_benchmark
    ? (() => {
        const p = D().procedures[c.cash_benchmark.procedure_id];
        return {
          status: "ok",
          procedure_id: c.cash_benchmark.procedure_id,
          label: c.cash_benchmark.label,
          basis: c.cash_benchmark.basis,
          national_low_usd: c.cash_benchmark.national_low_usd,
          national_avg_usd: c.cash_benchmark.national_avg_usd,
          national_high_usd: c.cash_benchmark.national_high_usd,
          badges: { national_avg_usd: c.cash_benchmark.basis === "observed" ? "observed" : "estimated", national_low_usd: "estimated", national_high_usd: "estimated" },
          source_url: p.provenance.source_url,
          period: p.provenance.period,
          api_url: c.cash_benchmark.url,
        };
      })()
    : { status: "no_source_at_this_level", geo: "national", reason: "Real Dental Costs publishes no cash band for this code." };
  const out: Any = {
    tool: "medicaid_paid_by_code",
    code,
    label: c.label,
    measure: D().medicaid.meta.measure,
    national: nationalPaid(code, lang, true),
    cash_benchmark: cash,
  };
  if (st) {
    const cell = medicaidPaid(code, st, lang, true);
    if (cell.status === "ok") {
      const ranked = Object.entries(D().medicaid.codes[code].states as Record<string, Any>)
        .filter(([, v]) => v.latest && v.quality_flag !== NOMINAL)
        .sort((a, b) => b[1].latest.paid_per_line_wavg - a[1].latest.paid_per_line_wavg);
      cell.rank = { rank: ranked.findIndex(([k]) => k === st) + 1, of: ranked.length, by: "paid_per_line_wavg, highest = 1; states with nominal amounts excluded", badge: "derived" };
    }
    out.state = { code: st, name: D().states[st].name };
    out.cell = cell;
    out.official_fee = feeSchedule(code, st, lang);
  } else {
    out.states_latest = {
      label: T.tmsis[lang],
      period: c.national.period,
      source_url: D().medicaid.meta.source_url,
      api_url: apiMedicaid(code),
      rows: Object.entries(c.states as Record<string, Any>)
        .filter(([, v]) => v.latest)
        .map(([k, v]) =>
          v.quality_flag === NOMINAL
            ? { state: k, status: "amounts_not_reliable", reason: NOMINAL_REASON, lines: v.latest.lines, quality_flag: v.quality_flag }
            : {
                state: k,
                paid_per_line_wavg: v.latest.paid_per_line_wavg,
                median_cell: v.latest.median_cell,
                p25: v.latest.p25,
                p75: v.latest.p75,
                lines: v.latest.lines,
                quality_flag: v.quality_flag,
                ...(v.quality_flag === "non_npi_identifiers" ? { caveat: NON_NPI_CAVEAT } : {}),
              },
        ),
    };
  }
  out.links = { code_page: `${SITE}/en/dental-codes/${code.toLowerCase()}/?${UTM}`, api: apiMedicaid(code) };
  out.disclaimer = T.disclaimer[lang];
  return out;
}

// ---------------------------------------------------------------------------
// tool 4: low_cost_dental_options
// ---------------------------------------------------------------------------
export function lowCostDentalOptions(st: string, county: string | undefined, lang: Lang): Any {
  const o = D().options[st];
  const fq = o.fqhc ?? {};
  const centers = {
    status: "ok",
    find_url: fq.find_url,
    designated_dental_hpsas: fq.designated_dental_hpsas,
    rural_dental_hpsas: fq.rural_dental_hpsas,
    fqhc_dental_hpsas: fq.fqhc_dental_hpsas,
    measure: "HRSA Dental Health Professional Shortage Area designations (not clinic counts)",
    source: fq.source,
    source_url: FREE_CSV,
    effective_date: o.hpsa_snapshot_date,
  };
  let countyBlock: Any;
  if (county) {
    const norm = (s: string) => s.toLowerCase().replace(/\b(county|parish|borough|census area|municipality|city and borough)\b/g, "").replace(/[^a-z]/g, "");
    const c = o.counties.find((x: Any) => norm(x.county) === norm(county));
    countyBlock = c
      ? {
          status: "ok",
          county: c.county,
          fips: c.fips,
          dental_hpsa_designations: c.hpsa?.designations ?? null,
          dental_hpsa_max_score: c.hpsa?.max_score ?? null,
          dental_hpsa_population: c.hpsa?.population ?? null,
          income_level: c.income_level,
          income_vintage: o.acs_vintage,
          dental_desert: c.desert,
          source_url: ATLAS_CSV,
          effective_date: o.hpsa_snapshot_date,
        }
      : { status: "no_source_at_this_level", geo: "county", query: county, next_level: { geo: "state", ...centers } };
  }
  return {
    tool: "low_cost_dental_options",
    state: { code: st, name: D().states[st].name },
    dental_schools: {
      in_state: o.dental_schools?.in_state ?? [],
      nearest_out_of_state: o.dental_schools?.nearest_out_of_state ?? null,
      prices_note: T.schools[lang],
      checked_at: o.checked_at,
      source_url: FREE_CSV,
    },
    health_centers: centers,
    ...(countyBlock ? { county: countyBlock } : {}),
    mission_of_mercy: { ...o.mission_of_mercy, source_url: FREE_CSV },
    charity: { ...o.charity, source_url: FREE_CSV },
    links: { state: `${SITE}/en/free-dental-care-by-state/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

// ---------------------------------------------------------------------------
// tool 1: benchmark_treatment_plan
// ---------------------------------------------------------------------------
export interface PlanLine {
  code?: string;
  procedure?: string;
  qty?: number;
  quoted_usd?: number;
}

export function benchmarkTreatmentPlan(st: string, lines: PlanLine[], coverage: string, lang: Lang, city?: string): Any {
  const d = D();
  const bundleOf = (code: string) => Object.keys(CDT_BUNDLES).find((id) => CDT_BUNDLES[id].groups.flat().includes(code));
  const bundleOut = bundles(st, lines);
  const outLines = lines.map((ln) => {
    const qty = ln.qty ?? 1;
    const input = {
      basis: "user_input",
      ...(ln.code ? { code: ln.code.toUpperCase() } : {}),
      ...(ln.procedure ? { procedure: ln.procedure } : {}),
      qty,
      ...(ln.quoted_usd != null ? { quoted_usd: ln.quoted_usd } : {}),
    };
    const perUnit = ln.quoted_usd != null ? round2(ln.quoted_usd / qty) : null;
    if (ln.code) {
      const code = ln.code.toUpperCase();
      const c = d.medicaid.codes[code];
      if (!c && BUNDLE_LABEL[code])
        return {
          input,
          status: "bundle_line",
          label: BUNDLE_LABEL[code],
          bundle: lines.some((l) => /^D611[45]$/i.test(l.code ?? "")) && CDT_BUNDLES.allon4.extra?.includes(code)
            ? "allon4"
            : bundleOf(code) === "implant" && !bundleOut.some((b) => b.bundle === "implant") && bundleOut.some((b) => b.bundle === "implant_bridge")
              ? "implant_bridge"
              : bundleOf(code),
          message: "Priced as part of a bundle (see bundles): Real Dental Costs publishes no per-line figure for this code.",
        };
      if (!c) return { input, status: "not_covered", message: T.notCovered[lang] };
      const procId = c.cash_benchmark?.procedure_id;
      const chain = chainPrices(code, st);
      return {
        input,
        status: "ok",
        label: c.label,
        cash_band: procId
          ? cashBand(procId, st, perUnit, UNIT_COMPARABLE.has(code))
          : {
              status: "no_source_at_this_level",
              geo: "state",
              reason: "Real Dental Costs publishes no cash band for this code.",
              next_level: { geo: "national", status: "no_source_at_this_level" },
            },
        medicaid_paid: medicaidPaid(code, st, lang, false, true),
        fee_schedule: feeSchedule(code, st, lang, true),
        ...(chain ? { chain_price: chain } : {}),
      };
    }
    const procId = ln.procedure as string;
    if (!d.procedures[procId]) return { input, status: "not_covered", message: T.notCovered[lang] };
    const chain = chainPrices(procId, st);
    return {
      input,
      status: "ok",
      label: d.states[st].procedures[procId].label,
      cash_band: cashBand(procId, st, perUnit, true),
      medicaid_paid: { status: "code_required", reason: "T-MSIS amounts are published per CDT code: add the code to see them." },
      fee_schedule: { status: "code_required", reason: "Fee schedules are published per CDT code." },
      ...(chain ? { chain_price: chain } : {}),
    };
  });
  const quoted = lines.filter((l) => l.quoted_usd != null);
  const verdictOf = (l: Any) => l.cash_band?.position?.verdict ?? l.cash_band?.next_level?.position?.vs_national;
  const ref = (l: Any) => l.input.code ?? l.input.procedure;
  const bref = (b: Any) => `bundle:${b.bundle}`;
  const result: Any = {
    tool: "benchmark_treatment_plan",
    state: { code: st, name: d.states[st].name },
    coverage: { category: coverage, note: COVERAGE_NOTE[coverage][lang] },
    legend: {
      medicaid_paid: `${T.tmsis[lang]}: ${D().medicaid.meta.measure}. Source: ${D().medicaid.meta.source}.`,
      fee_schedule: T.fee[lang],
      position: "Derived: quoted_usd / qty compared with the band's low_usd and high_usd; the band edges are modelled (estimated).",
      badges: "observed = measured average; estimated = editorial estimate or modelled figure, not collected; undated_schedule = fee schedule without an effective date in the source.",
      api: { state: apiState(st), medicaid: `${SITE}/api/v1/medicaid/{code}.json` },
      quality_evidence: Object.fromEntries(
        outLines
          .filter((l: Any) => l.medicaid_paid?.quality_flag && l.medicaid_paid.quality_flag !== "ok")
          .map((l: Any) => [l.input.code, d.medicaid.codes[l.input.code].states[st].quality_evidence]),
      ),
    },
    lines: outLines,
    ...(bundleOut.length ? { bundles: bundleOut } : {}),
    ...(city ? { city_reference: cityReference(city) } : {}),
    totals: {
      basis: "user_input",
      quoted_total_usd: round2(quoted.reduce((n, l) => n + (l.quoted_usd as number), 0)),
      lines_quoted: quoted.length,
      lines_total: lines.length,
      above_band: [
        ...outLines.filter((l) => /^above/.test(verdictOf(l) ?? "")).map(ref),
        ...bundleOut.filter((b) => b.verdict === "above_band").map(bref),
      ],
      within_band: [
        ...outLines.filter((l) => verdictOf(l) === "within_band").map(ref),
        ...bundleOut.filter((b) => b.verdict === "within_band").map(bref),
      ],
      not_covered: outLines.filter((l) => l.status === "not_covered").map(ref),
    },
    medicaid_adult_rule: (() => {
      const { tool: _t, links: _l, disclaimer: _d, ...rule } = medicaidAdultDentalRules(st, lang);
      return rule;
    })(),
    links: { state: stateHubUrl(st), methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
  result.source_notes = sourceNotes(result);
  return result;
}

/** Numbered list of distinct sources (URL + date) found anywhere in the result. */
export function sourceNotes(obj: Any): Any[] {
  const seen = new Map<string, Any>();
  const walk = (o: Any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.source_url === "string" && !seen.has(o.source_url))
      seen.set(o.source_url, {
        url: o.source_url,
        date: o.period ?? o.effective_date ?? o.checked_at ?? o.as_of ?? null,
        ...(o.source ? { name: o.source } : {}),
      });
    Object.values(o).forEach(walk);
  };
  walk(obj);
  return [...seen.values()];
}

// ---------------------------------------------------------------------------
// lot C1: compare_states, us_dental_spending_stats, canada_dental_cost_by_province, cdcp_coverage_check
// ---------------------------------------------------------------------------
const pct1 = (n: number) => Math.round(n * 10) / 10;

/** 2-5 states side by side for one procedure: values from compare-data.ts, provenance from API v1 /state/{st}.json. */
export function compareStates(procId: string, codes: string[], lang: Lang): Any {
  const d = D();
  const nat = d.procedures[procId];
  const all = Object.keys(COMPARE_PRICES);
  const noStateVariation = nat.basis === "national";
  const [nLow, nAvg, nHigh] = nationalTriple(procId).map(Math.round);
  const withheld = WITHHELD_SERIES[procId] != null;
  const states = codes.map((st) => {
    const p = d.states[st].procedures[procId].provenance;
    if (withheld)
      return {
        code: st,
        name: d.states[st].name,
        status: "no_source_at_this_level",
        geo: "state",
        withheld: true,
        reason: WITHHELD_NOTE[lang],
        source_url: THIRD_PARTY_TERMS.source_url,
        period: p.period,
        link: stateHubUrl(st),
      };
    const [low, avg, high] = COMPARE_PRICES[st][procId];
    return {
      code: st,
      name: d.states[st].name,
      low_usd: low,
      avg_usd: avg,
      high_usd: high,
      currency: "USD",
      badges: { ...badges(nat.basis), ...(noStateVariation ? {} : { rank_by_avg: "derived", vs_national_avg_pct: "derived" }) },
      ...(noStateVariation
        ? { state_variation: "none: every state carries the national range" }
        : {
            rank_by_avg: all.filter((s) => COMPARE_PRICES[s][procId][1] < avg).length + 1,
            of_states: all.length,
            vs_national_avg_pct: pct1(((avg - nAvg) / nAvg) * 100),
          }),
      source: p.source,
      source_url: p.source_url,
      period: p.period,
      updated: p.updated,
      link: stateHubUrl(st),
    };
  });
  const prov = nat.provenance;
  return {
    tool: "compare_states",
    procedure: { id: procId, label: lang === "es" ? PROC_LABELS_ES[procId] ?? nat.label : nat.label, basis: nat.basis, basis_note: nat.basis_note },
    states,
    national: {
      geo: "national",
      low_usd: nLow,
      avg_usd: nAvg,
      high_usd: nHigh,
      currency: "USD",
      method: "Mean of the 51 state figures (incl. DC).",
      badges: { avg_usd: "derived", low_usd: "estimated", high_usd: "estimated" },
      source: withheld ? NATIONAL_SOURCE : prov.source,
      source_url: withheld ? nat.national.source : prov.source_url,
      period: prov.period,
    },
    legend: {
      rank_by_avg: "1 = the state with the smallest average among the 51 (ties share a rank).",
      badges: "observed = measured average; estimated = editorial estimate or modelled figure, not collected; derived = computed here from the figures shown.",
    },
    links: { compare: `${SITE}/en/compare/?${UTM}`, methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

/** National MEPS figures (AHRQ), as computed and published by Real Dental Costs (API v1 /meps/*.json). */
export function usDentalSpendingStats(lang: Lang): Any {
  const { national: n, longitudinal: l } = D().meps;
  const annual = Object.keys(n.years)
    .sort()
    .reverse()
    .map((y) => {
      const f = n.files.find((x: Any) => String(x.name).startsWith(y));
      return {
        period: y,
        geo: "national",
        source: `${n.source}, ${f?.puf ?? ""} ${f?.name ?? ""}; survey-weighted estimates computed by Real Dental Costs`.replace(/\s+/g, " "),
        source_url: n.endpoint,
        upstream_url: f?.url ?? null,
        upstream_released: f?.released ?? null,
        figures: n.years[y],
      };
    });
  const lf = l.files[0] ?? {};
  return {
    tool: "us_dental_spending_stats",
    measure_note:
      lang === "es"
        ? "Gasto por persona (todos los pagadores) y gasto de bolsillo de la encuesta federal MEPS: no es el costo de un procedimiento."
        : "Person-level spending (all payers) and out-of-pocket amounts from the federal MEPS survey: not the cost of a procedure.",
    annual,
    paired_change_same_persons: {
      period: "2023-2024",
      geo: "national",
      population: "the same persons in both years (MEPS Panel 28 longitudinal file)",
      source: `${l.source}, ${lf.puf ?? ""} ${lf.name ?? ""}; computed by Real Dental Costs`.replace(/\s+/g, " "),
      source_url: l.endpoint,
      upstream_url: lf.url ?? null,
      upstream_released: lf.released ?? null,
      figures: l.paired_change,
      reading: l.reading,
    },
    caveats: [...n.caveats, ...l.caveats.filter((c: string) => !n.caveats.includes(c))],
    links: { api: `${SITE}/en/api/?${UTM}`, methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

export const CA_PROVINCE_CODES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export const CA_PROCEDURES = [
  "recall_exam",
  "scaling_per_unit",
  "filling_1surface_composite",
  "simple_extraction",
  "root_canal_molar",
  "complete_denture_per_arch",
  "partial_denture_cast_metal",
  "crown_ceramic",
  "single_implant_fixture_abutment_crown",
] as const;
const CA_NAMES: Record<string, [string, string]> = {
  AB: ["Alberta", "Alberta"], BC: ["British Columbia", "Columbia Británica"], MB: ["Manitoba", "Manitoba"],
  NB: ["New Brunswick", "Nuevo Brunswick"], NL: ["Newfoundland and Labrador", "Terranova y Labrador"],
  NS: ["Nova Scotia", "Nueva Escocia"], NT: ["Northwest Territories", "Territorios del Noroeste"], NU: ["Nunavut", "Nunavut"],
  ON: ["Ontario", "Ontario"], PE: ["Prince Edward Island", "Isla del Príncipe Eduardo"], QC: ["Quebec", "Quebec"],
  SK: ["Saskatchewan", "Saskatchewan"], YT: ["Yukon", "Yukón"],
};
const CA_LABELS: Record<string, [string, string]> = {
  recall_exam: ["Recall exam", "Examen de control"],
  scaling_per_unit: ["Scaling / cleaning (per unit)", "Limpieza / raspado (por unidad)"],
  filling_1surface_composite: ["Composite filling (1 surface)", "Empaste de resina (1 superficie)"],
  simple_extraction: ["Simple extraction", "Extracción simple"],
  root_canal_molar: ["Root canal (molar)", "Endodoncia (molar)"],
  complete_denture_per_arch: ["Complete denture (per arch)", "Dentadura completa (por arcada)"],
  partial_denture_cast_metal: ["Cast partial denture", "Dentadura parcial colada"],
  crown_ceramic: ["Ceramic crown", "Corona de cerámica"],
  single_implant_fixture_abutment_crown: ["Single implant (fixture, abutment, crown)", "Implante unitario (implante, pilar, corona)"],
};
const CA_SLUG: Record<string, string> = {
  AB: "alberta", BC: "british-columbia", MB: "manitoba", NB: "new-brunswick", NL: "newfoundland-and-labrador",
  NS: "nova-scotia", ON: "ontario", PE: "prince-edward-island", QC: "quebec", SK: "saskatchewan",
};
const caName = (p: string, lang: Lang) => CA_NAMES[p][lang === "es" ? 1 : 0];
const caLabel = (k: string, lang: Lang) => CA_LABELS[k][lang === "es" ? 1 : 0];
const CA_PERIOD_NOTE = "Dataset edition 2026; the source of a row may be an earlier guide (see source_url).";

function caFee(prov: string, key: string, lang: Lang): Any {
  const c = D().canada;
  const head = { procedure: key, label: caLabel(key, lang) };
  const f = c.provinces[prov]?.fees[key];
  if (!f)
    return {
      ...head,
      status: "no_source_at_this_level",
      geo: c.provinces[prov] ? "province" : "territory",
      reason: "The open dataset covers the 10 provinces; it has no row here.",
      next_level: { geo: "national", status: "no_source_at_this_level", reason: "The dataset publishes no Canada-wide figure per procedure." },
    };
  if (f.data_quality === "under_review")
    return { ...head, status: "withheld", data_quality: "under_review", issue: f.issue, note: f.note, row_source_url: f.source_url };
  return {
    ...head,
    status: "ok",
    amount_cad: f.amount_cad,
    ...(f.min_cad != null ? { min_cad: f.min_cad } : {}),
    ...(f.max_cad != null ? { max_cad: f.max_cad } : {}),
    currency: "CAD",
    badge: f.is_estimate ? "estimated" : "observed",
    source_url: f.source_url,
    period: "2026",
    period_note: CA_PERIOD_NOTE,
  };
}

export function canadaDentalCostByProvince(prov: string, key: string | undefined, lang: Lang): Any {
  const c = D().canada;
  const keys = key ? [key] : [...CA_PROCEDURES];
  return {
    tool: "canada_dental_cost_by_province",
    province: { code: prov, name: caName(prov, lang) },
    fees: keys.map((k) => caFee(prov, k, lang)),
    legend: {
      amount_cad: "Amount per row as published by its source (a provincial suggested-fee guide, or a clinic or relay page where the guide is not public); min/max when the source gives a range.",
      badges: "observed = amount read in the cited source; estimated = marked as an estimate in the dataset.",
      under_review: "A row with an open data-quality issue is withheld (no value) until the dataset correction.",
      cdcp: "The Canadian Dental Care Plan pays on its own fee grid, often below these amounts: see cdcp_coverage_check.",
    },
    dataset: { ...c.dataset },
    links: {
      ...(CA_SLUG[prov] ? { province: `${SITE}/ca/dental-costs-${CA_SLUG[prov]}/?${UTM}` } : {}),
      methodology: `${SITE}/en/methodology/?${UTM}`,
    },
    disclaimer: T.disclaimer[lang],
  };
}

export function cdcpCoverageCheck(income: number, prov: string, key: string | undefined, lang: Lang): Any {
  const c = D().canada;
  const t = [...c.tiers].reverse().find((x: Any) => income >= x.lower_bound_cad) ?? c.tiers[0];
  const eligible = t.cdcp_share_pct > 0;
  const keys = key ? [key] : [...CA_PROCEDURES];
  const coverage = keys.map((k) => {
    const r = c.cdcp[k];
    return {
      procedure: k,
      label: caLabel(k, lang),
      covered: r.covered,
      preauth_required: r.preauth_required,
      rule_fr: r.rule_fr,
      ...(key ? { notes_fr: r.notes_fr } : {}),
      source_url: r.source_url,
      period: "2026",
      as_of: c.dataset.audited_at,
    };
  });
  let estimate: Any;
  if (!key) estimate = { status: "procedure_required", reason: "Give a procedure to get an estimated co-pay." };
  else if (!eligible) estimate = { status: "not_eligible_by_income", reason: "The plan pays no share at this income tier." };
  else if (c.cdcp[key].covered === "no") estimate = { status: "not_covered", reason: "The plan guide excludes this procedure." };
  else {
    const fee = caFee(prov, key, lang);
    estimate =
      fee.status !== "ok"
        ? { status: "no_fee_reference", fee_reference: fee }
        : {
            status: "ok",
            badge: "estimated",
            fee_reference_cad: fee.amount_cad,
            copay_pct: t.copay_pct,
            cdcp_share_pct: t.cdcp_share_pct,
            estimated_copay_cad: round2((fee.amount_cad * t.copay_pct) / 100),
            estimated_cdcp_share_cad: round2((fee.amount_cad * t.cdcp_share_pct) / 100),
            currency: "CAD",
            method:
              "Provincial fee reference x income-tier percentages. The plan applies the percentages to its own grid fee, often below the provincial guide; a dentist may bill the difference, so the real balance can be higher.",
            ...(c.cdcp[key].preauth_required !== "false" ? { preauth: "Pre-authorization may be required: see coverage[].rule_fr." } : {}),
            source_url: fee.source_url,
            period: "2026",
            tier_source_url: c.tiers_source.source_url,
          };
  }
  return {
    tool: "cdcp_coverage_check",
    input: { basis: "user_input", adjusted_family_net_income_cad: income, province: prov },
    province: { code: prov, name: caName(prov, lang) },
    income_tier: {
      id: t.id,
      band: t.band_en,
      lower_bound_cad: t.lower_bound_cad,
      cdcp_share_pct: t.cdcp_share_pct,
      copay_pct: t.copay_pct,
      eligible_by_income: eligible,
      note: "Income is one eligibility condition; the Government of Canada sets the others (see source). Percentages apply to the plan's own fee grid, not to a dentist's bill.",
      source: c.tiers_source.source,
      source_url: c.tiers_source.source_url,
      period: c.tiers_source.period,
    },
    coverage,
    estimate,
    links: { tiers: `${SITE}/ca/cdcp-eligibility-income-tiers/?${UTM}`, coverage: `${SITE}/ca/cdcp-coverage/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

// ---------------------------------------------------------------------------
// lot C2: insurance_out_of_pocket, medicare_dental_check, dental_program_changes
// ---------------------------------------------------------------------------
export interface OopLine {
  procedure: string;
  qty?: number;
  coinsurance_pct?: number;
  class?: string;
  deductible_applies?: boolean;
}
export interface OopParams {
  coverage: "private" | "medicare_advantage";
  deductible_remaining_usd?: number;
  annual_max_remaining_usd?: number;
  no_annual_maximum?: boolean;
  coinsurance_by_class?: Record<string, number>;
}

const OOP_FORMULA = {
  en: "Per line, in the order given: gross = band amount x qty; deductible applied = min(gross, deductible remaining) (0 when deductible_applies is false); plan pays = min((gross - deductible applied) x (1 - coinsurance % / 100), annual maximum remaining); you pay = gross - plan pays. Deductible and annual maximum remaining carry from line to line. Run three times: on the low, average and high of the cash band.",
  es: "Por línea, en el orden dado: bruto = importe de la banda x cantidad; deducible aplicado = min(bruto, deducible restante) (0 si deductible_applies es false); el plan paga = min((bruto - deducible aplicado) x (1 - coaseguro % / 100), máximo anual restante); usted paga = bruto - lo que paga el plan. El deducible y el máximo anual restantes pasan de una línea a la siguiente. Se calcula tres veces: con el bajo, el promedio y el alto de la banda en efectivo.",
};
const OOP_NOTE: Record<string, { en: string; es: string }> = {
  private: {
    en: "Every plan parameter comes from the user. A plan computes its share on its own allowed amount, which Real Dental Costs does not publish: this estimate uses the cash band as the billed amount. Waiting periods, frequency limits, missing-tooth clauses and network rules are not modelled; read them in the plan document.",
    es: "Cada parámetro del plan lo da el usuario. Un plan calcula su parte sobre su propio importe permitido, que Real Dental Costs no publica: esta estimación usa la banda en efectivo como importe facturado. Periodos de espera, límites de frecuencia, cláusulas de diente ausente y reglas de red no se modelan; léalos en el documento del plan.",
  },
  medicare_advantage: {
    en: "Medicare Advantage dental benefits are set plan by plan; the parameters come from the user's own plan document (Evidence of Coverage). Real Dental Costs tracks no plan-level figure. A plan computes its share on its own allowed amount: this estimate uses the cash band as the billed amount. Original Medicare: see medicare_dental_check.",
    es: "Los beneficios dentales de Medicare Advantage se fijan plan por plan; los parámetros vienen del documento del propio plan del usuario (Evidence of Coverage). Real Dental Costs no sigue ninguna cifra por plan. Un plan calcula su parte sobre su propio importe permitido: esta estimación usa la banda en efectivo como importe facturado. Medicare Original: vea medicare_dental_check.",
  },
};

export function insuranceOutOfPocket(st: string, lines: OopLine[], p: OopParams, lang: Lang): Any {
  const d = D();
  const SCEN = ["low", "avg", "high"] as const;
  const ded: Record<string, number> = {};
  const max: Record<string, number | null> = {};
  const sum: Record<string, { gross_usd: number; plan_pays_usd: number; you_pay_usd: number }> = {};
  for (const s of SCEN) {
    ded[s] = p.deductible_remaining_usd ?? 0;
    max[s] = p.no_annual_maximum ? null : p.annual_max_remaining_usd ?? 0;
    sum[s] = { gross_usd: 0, plan_pays_usd: 0, you_pay_usd: 0 };
  }
  const globalMissing = [
    ...(p.deductible_remaining_usd == null ? ["deductible_remaining_usd"] : []),
    ...(p.annual_max_remaining_usd == null && !p.no_annual_maximum ? ["annual_max_remaining_usd (or no_annual_maximum: true)"] : []),
  ];
  let computed = 0;
  const out = lines.map((ln) => {
    const qty = ln.qty ?? 1;
    const fromClass = ln.class != null ? p.coinsurance_by_class?.[ln.class] : undefined;
    const coins = ln.coinsurance_pct ?? fromClass;
    const input = {
      basis: "user_input",
      procedure: ln.procedure,
      qty,
      ...(ln.coinsurance_pct != null ? { coinsurance_pct: ln.coinsurance_pct } : {}),
      ...(ln.class != null ? { class: ln.class } : {}),
      deductible_applies: ln.deductible_applies !== false,
    };
    if (!d.procedures[ln.procedure]) return { input, status: "not_covered", message: T.notCovered[lang] };
    const raw = cashBand(ln.procedure, st, null, true);
    const band = raw.status === "ok" ? raw : raw.next_level;
    const { position: _p, ...bandOut } = band;
    const cash_band = raw.status === "ok" ? bandOut : { ...raw, next_level: bandOut };
    const missing = [
      ...globalMissing,
      ...(coins == null
        ? [ln.class != null ? `coinsurance_by_class["${ln.class}"]` : "coinsurance_pct (or a class listed in coinsurance_by_class)"]
        : []),
    ];
    if (missing.length)
      return {
        input,
        status: "parameter_missing",
        missing,
        message:
          lang === "es"
            ? "Falta un parámetro del plan: esta línea no se calcula. Real Dental Costs no supone ningún deducible, máximo, clase ni porcentaje."
            : "A plan parameter is missing: this line is not computed. Real Dental Costs assumes no deductible, maximum, class or percentage.",
        cash_band,
      };
    computed++;
    const scenarios: Any = {};
    for (const s of SCEN) {
      const gross = round2((band[`${s}_usd`] as number) * qty);
      const dedApplied = ln.deductible_applies === false ? 0 : round2(Math.min(gross, ded[s]));
      const share = round2((gross - dedApplied) * (1 - (coins as number) / 100));
      const planPays = max[s] == null ? share : round2(Math.min(share, max[s] as number));
      ded[s] = round2(ded[s] - dedApplied);
      if (max[s] != null) max[s] = round2((max[s] as number) - planPays);
      const youPay = round2(gross - planPays);
      scenarios[`at_${s}`] = { gross_usd: gross, deductible_applied_usd: dedApplied, plan_pays_usd: planPays, you_pay_usd: youPay, ...(max[s] != null && planPays < share ? { annual_maximum_reached: true } : {}) };
      sum[s].gross_usd = round2(sum[s].gross_usd + gross);
      sum[s].plan_pays_usd = round2(sum[s].plan_pays_usd + planPays);
      sum[s].you_pay_usd = round2(sum[s].you_pay_usd + youPay);
    }
    return {
      input,
      status: "ok",
      label: band.label,
      cash_band,
      estimate: {
        badge: "estimated",
        coinsurance_pct_used: coins,
        coinsurance_from: ln.coinsurance_pct != null ? "line" : `coinsurance_by_class["${ln.class}"]`,
        ...scenarios,
        source: band.source,
        source_url: band.source_url,
        period: band.period,
      },
    };
  });
  const genDay = day(d.states[st].generated_at);
  return {
    tool: "insurance_out_of_pocket",
    state: { code: st, name: d.states[st].name },
    input: {
      basis: "user_input",
      coverage: p.coverage,
      ...(p.deductible_remaining_usd != null ? { deductible_remaining_usd: p.deductible_remaining_usd } : {}),
      ...(p.annual_max_remaining_usd != null ? { annual_max_remaining_usd: p.annual_max_remaining_usd } : {}),
      ...(p.no_annual_maximum ? { no_annual_maximum: true } : {}),
      ...(p.coinsurance_by_class ? { coinsurance_by_class: p.coinsurance_by_class } : {}),
    },
    coverage: { category: p.coverage, note: OOP_NOTE[p.coverage][lang] },
    formula: OOP_FORMULA[lang],
    lines: out,
    totals:
      computed > 0
        ? {
            badge: "estimated",
            lines_computed: computed,
            lines_total: lines.length,
            at_low: sum.low,
            at_avg: sum.avg,
            at_high: sum.high,
            remaining_after: {
              deductible_usd: { at_low: ded.low, at_avg: ded.avg, at_high: ded.high },
              annual_maximum_usd: p.no_annual_maximum ? "no annual maximum (user input)" : { at_low: max.low, at_avg: max.avg, at_high: max.high },
            },
            note: "Totals of the computed lines only; every band comes from the Real Dental Costs API v1 state file.",
            source_url: apiState(st),
            period: `API v1 state file generated ${genDay}`,
          }
        : { status: "not_computed", reason: "No line could be computed: see lines[].missing." },
    links: { insurance: `${SITE}/en/dental-insurance/?${UTM}`, methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

export function medicareDentalCheck(coverage: string, lang: Lang): Any {
  const m = D().programs.medicare;
  const q = (id: string) => {
    const r = m.quotes.find((x: Any) => x.id === id);
    return { quote: r.quote, source: r.source_title, source_url: r.source_url, retrieved_at: r.retrieved_at, as_of: day(r.retrieved_at) };
  };
  const es = lang === "es";
  return {
    tool: "medicare_dental_check",
    input: { basis: "user_input", coverage },
    original_medicare: {
      rule: "excluded_with_narrow_exceptions",
      summary: es
        ? "Medicare Original (Partes A y B) excluye por ley la atención dental de rutina (cuidado, tratamiento, empastes, extracción o reemplazo de dientes). Excepciones limitadas: ciertos servicios dentales con hospitalización o ligados a un tratamiento médico cubierto. Citas literales abajo."
        : "Original Medicare (Parts A and B) excludes routine dental care by statute (care, treatment, filling, removal or replacement of teeth). Narrow exceptions: some dental services with a hospital admission or linked to a covered medical treatment. Verbatim quotes below.",
      statute: q("statute"),
      regulation: q("regulation"),
      medicare_gov: [q("original_medicare_rule_1"), q("original_medicare_rule_2"), q("original_medicare_rule_3")],
    },
    medicare_advantage: {
      status: "not_yet_tracked",
      scope: "2027 Medicare Advantage plans, their dental benefits and their dollar limits plan by plan",
      reason: es
        ? "Cada plan publica sus beneficios dentales; Real Dental Costs aún no los sigue. Ninguna cifra de plan se da aquí."
        : "Each plan publishes its own dental benefits; Real Dental Costs does not track them yet. No plan figure is given here.",
      enrollment_period: q("enrollment_period"),
      next_step: {
        tool: "insurance_out_of_pocket",
        arguments: { coverage: "medicare_advantage" },
        note: es
          ? "Si el usuario conoce el deducible, el máximo anual y el coaseguro de su plan (Evidence of Coverage), insurance_out_of_pocket estima su gasto de bolsillo sobre la banda en efectivo del estado."
          : "If the user knows the plan's deductible, annual maximum and coinsurance (Evidence of Coverage), insurance_out_of_pocket estimates the out-of-pocket amount on the state cash band.",
      },
    },
    other_tools: {
      cash_cost: "dental_cost_by_state",
      lower_cost_care: "low_cost_dental_options",
      adult_medicaid_rule: "medicaid_adult_dental_rules",
    },
    links: { medicare_advantage: `${SITE}/en/medicare-advantage-dental-coverage/?${UTM}`, methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
/** Effective date stated in a cap's period text (verbatim from the caps table), or null. */
function capEffectiveDate(period: string): string | null {
  const iso = (y: number, mo: number, dd: number) => `${y}-${String(mo).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const m = period.match(/(?:effective|on and after) (\w+) (\d{1,2}), (\d{4})/i);
  if (m && MONTHS.includes(m[1].toLowerCase())) return iso(Number(m[3]), MONTHS.indexOf(m[1].toLowerCase()) + 1, Number(m[2]));
  const n = period.match(/(\d{1,2})\/(\d{1,2})\/(\d{2}) and on/);
  return n ? iso(2000 + Number(n[3]), Number(n[1]), Number(n[2])) : null;
}
const CHANGE_KIND = {
  rate_change: { en: "Medicaid dental fee schedule: rate change", es: "Baremo dental de Medicaid: cambio de tarifas" },
  schedule: { en: "Medicaid dental fee schedule in force from this date", es: "Baremo dental de Medicaid vigente desde esta fecha" },
  cap: { en: "Adult Medicaid annual dental cap: effective date", es: "Tope dental anual de Medicaid adulto: fecha de efecto" },
};

export function dentalProgramChanges(st: string | undefined, from: string | undefined, to: string | undefined, lang: Lang): Any {
  const d = D();
  const KIND_ID = { rate_change: "medicaid_fee_schedule_rate_change", schedule: "medicaid_fee_schedule_effective", cap: "adult_dental_cap_effective" } as const;
  const k = (key: keyof typeof CHANGE_KIND) => ({ kind: KIND_ID[key] });
  const events: Any[] = [];
  const tx = d.programs.tx_rate_change;
  {
    const pcts = tx.rows.map((r: Any) => r.pct_change).sort((a: number, b: number) => a - b);
    events.push({
      state: tx.code,
      ...k("rate_change"),
      effective_date: tx.effective_date,
      previous_effective_date: tx.previous_effective_date,
      published_at: tx.published_at,
      program: tx.program,
      hearing: tx.hearing,
      codes_changed: tx.rows.length,
      pct_change_range: { min: pcts[0], max: pcts[pcts.length - 1], unit: "percent (0.55 = +0.55 %)", badge: "derived" },
      licence_note: tx.licence_note,
      source: "Texas Medicaid & Healthcare Partnership (TMHP), rate change notice",
      source_url: tx.news_url,
      data_file_url: tx.file_url,
      ...(st === tx.code
        ? {
            rows: tx.rows.map((r: Any) => {
              const ok = /^(\d{1,2})-(\d{1,2})$/.exec(r.age_range);
              return ok && Number(ok[2]) <= 20
                ? r
                : { ...r, age_range: null, age_range_as_extracted: r.age_range, age_range_status: "not_parsed_reliably_from_source_file" };
            }),
          }
        : { rows: "pass state TX to list the codes" }),
    });
  }
  for (const [code, r] of Object.entries(d.rules) as [string, Any][]) {
    if (r.schedule?.effective_date)
      events.push({
        state: code,
        ...k("schedule"),
        effective_date: r.schedule.effective_date,
        schedule_scope: scheduleScope(code),
        source_url: r.schedule.source_url,
      });
    const eff = r.cap?.period ? capEffectiveDate(r.cap.period) : null;
    if (eff && r.cap.cap_usd != null)
      events.push({
        state: code,
        ...k("cap"),
        effective_date: eff,
        cap_usd: r.cap.cap_usd,
        cap_kind: r.cap.cap_kind,
        period: r.cap.period,
        ...(st ? { quote: r.cap.quote, source: r.cap.source_title } : {}),
        source_url: r.cap.source_url,
        retrieved_at: r.cap.retrieved_at,
      });
  }
  const inRange = (e: Any) => (!from || e.effective_date >= from) && (!to || e.effective_date <= to);
  const tracked = new Set(events.map((e) => e.state));
  const list = events
    .filter((e) => (!st || e.state === st) && inRange(e))
    .sort((a, b) => (a.effective_date < b.effective_date ? 1 : a.effective_date > b.effective_date ? -1 : a.state.localeCompare(b.state)));
  const allStates = Object.keys(d.states).sort();
  const es = lang === "es";
  const status = st && !tracked.has(st) ? "not_yet_tracked" : list.length ? "ok" : "none_tracked_in_period";
  return {
    tool: "dental_program_changes",
    input: { basis: "user_input", ...(st ? { state: st } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
    ...(st ? { state: { code: st, name: d.states[st].name } } : {}),
    status,
    ...(status === "not_yet_tracked"
      ? { message: es ? "Real Dental Costs aún no sigue cambios fechados para este estado. Esto no significa que no haya habido cambios." : "Real Dental Costs does not track dated changes for this state yet. This does not mean nothing changed." }
      : status === "none_tracked_in_period"
        ? { message: es ? "Ningún cambio seguido cae en este periodo. Esto no significa que no haya habido cambios." : "No tracked change falls in this period. This does not mean nothing changed." }
        : {}),
    tracked: es
      ? "Cambios adoptados y fechados: cambio de tarifas del baremo de Texas (01/09/2026), fecha de vigencia de los baremos oficiales de Medicaid, fecha de efecto de los topes dentales anuales de adultos cuando la fuente la indica."
      : "Adopted, dated changes: Texas fee schedule rate change (2026-09-01), effective date of official Medicaid fee schedules, effective date of adult annual dental caps when the source states one.",
    not_yet_tracked: "Other program changes (covered services, eligibility, managed-care contracts, proposed rules), Medicare Advantage plan changes, private plans.",
    kinds: Object.fromEntries(
      (Object.keys(CHANGE_KIND) as (keyof typeof CHANGE_KIND)[]).map((key) => [
        KIND_ID[key],
        key === "schedule"
          ? { label: CHANGE_KIND[key][lang], note: "Effective date printed on the official schedule; Real Dental Costs publishes no before/after comparison for it." }
          : key === "cap"
            ? { label: CHANGE_KIND[key][lang], note: "Date stated in the cap source (period field, verbatim); the verbatim quote is listed when a state is given." }
            : { label: CHANGE_KIND[key][lang] },
      ]),
    ),
    changes: list,
    ...(st ? {} : { states_not_yet_tracked: allStates.filter((s) => !tracked.has(s)) }),
    links: { methodology: `${SITE}/en/methodology/?${UTM}` },
    disclaimer: T.disclaimer[lang],
  };
}
