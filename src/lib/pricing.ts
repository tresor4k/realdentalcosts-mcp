/**
 * Shared dental-pricing helpers (V5-Dental Strict).
 *
 * ADAPTED FROM realdentalcosts.com `lib/pricing.ts` for standalone use in this
 * MCP server (no Next.js/React runtime here). Logic and numbers are
 * unchanged; only the import of the `PriceRow` type (originally from
 * `@/lib/jsonld`, a Next-only module) was inlined below, and the relative
 * import of compare-data.ts was adjusted with an explicit .js extension for
 * NodeNext ESM resolution.
 *
 * NOTE: lib/compare-data.ts is AUTO-GENERATED from the open US Dental Cost
 * Index CSV — never hand-edit it. This file derives from it instead.
 */

import {
  COMPARE_PROCEDURES,
  COMPARE_PRICES,
  type PayMode,
} from "./compare-data.js";

/** Minimal inlined shape of the upstream `PriceRow` type (jsonld.ts, not vendored here). */
export interface PriceRow {
  label: string;
  low: number;
  avg: number;
  high: number;
}

/** Typical PPO annual maximum used for the insured estimate. */
export const ANNUAL_MAX = 1500;

export const MODE_LABELS: Record<PayMode, string> = {
  cash: "Cash / no insurance",
  insurance: "With typical PPO insurance",
  savings: "With a dental savings plan",
};

/** USD formatter shared across the cost tools. */
export const fmtUsd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/**
 * Out-of-pocket estimate for a [low, avg, high] cash triple under a given
 * payment mode and procedure category. Mirrors the on-page coverage notes.
 */
export function outOfPocket(
  values: [number, number, number],
  cat: string,
  mode: PayMode,
): { vals: [number, number, number]; note: string } {
  if (mode === "cash") return { vals: values, note: "Full list price, before any discounts." };
  if (mode === "savings") {
    return {
      vals: [values[0] * 0.6, values[1] * 0.7, values[2] * 0.8],
      note: "Typical dental savings plan network discount of 20-40% off list price.",
    };
  }
  // insurance — typical PPO tiers, $1,500 annual max
  const apply = (share: number) =>
    values.map(v => Math.max(v - Math.min(v * share, ANNUAL_MAX), 0)) as [number, number, number];
  switch (cat) {
    case "preventive":
      return { vals: [0, 0, 0], note: "Preventive care is typically covered ~100% by PPO plans." };
    case "basic":
      return { vals: apply(0.8), note: "Basic tier: plan typically pays ~80%, up to the $1,500 annual max." };
    case "major":
      return { vals: apply(0.5), note: "Major tier: plan typically pays ~50%, up to the $1,500 annual max." };
    case "ortho":
      return { vals: apply(0.5), note: "Orthodontics: ~50% with a lifetime max where covered — adult ortho is often NOT covered." };
    case "cosmetic":
      return { vals: values, note: "Cosmetic procedures are not covered by dental insurance." };
    default: // excluded
      return { vals: values, note: "Implants are usually excluded; related steps (extraction, imaging) may be partly covered." };
  }
}

/** Arithmetic mean of the [low, avg, high] cash triple across all 51 states + DC. */
export function nationalTriple(procId: string): [number, number, number] {
  const codes = Object.keys(COMPARE_PRICES);
  let lo = 0, av = 0, hi = 0;
  for (const code of codes) {
    const v = COMPARE_PRICES[code][procId];
    lo += v[0];
    av += v[1];
    hi += v[2];
  }
  const n = codes.length || 1;
  return [lo / n, av / n, hi / n];
}

/**
 * National low/avg/high per procedure, derived (not invented) as the mean of
 * the 51 state + DC observations. Feeds the Dataset JSON-LD and the static
 * PriceDistributionChart on the procedure-cost-list pillar (upstream site).
 */
export const NATIONAL_ROWS: PriceRow[] = COMPARE_PROCEDURES.map(p => {
  const [low, avg, high] = nationalTriple(p.id);
  return { label: p.label, low: Math.round(low), avg: Math.round(avg), high: Math.round(high) };
});

/** Spanish procedure labels, keyed by COMPARE_PROCEDURES id (US Hispanic market). */
export const PROC_LABELS_ES: Record<string, string> = {
  exam: "Examen, limpieza y radiografías",
  filling: "Empaste de resina (1 diente)",
  deepclean: "Limpieza profunda (raspado y alisado, por cuadrante)",
  extraction: "Extracción dental",
  rootcanal: "Tratamiento de conducto (endodoncia)",
  crown: "Corona dental",
  whitening: "Blanqueamiento dental profesional",
  veneer: "Carilla de porcelana (por diente)",
  braces: "Ortodoncia (brackets tradicionales, caso completo)",
  implant: "Implante dental (completo)",
  dentures: "Dentadura postiza completa (ambas arcadas)",
  allon4: "All-on-4 (por arcada)",
};

/** Spanish internal links per procedure id (live /es/ pages). */
export const PROC_LINKS_ES: Record<string, string> = {
  exam: "/es/limpieza/",
  filling: "/es/tratamientos/empastes-dentales-precio/",
  deepclean: "/es/limpieza/limpieza-profunda-precio/",
  extraction: "/es/tratamientos/extraccion-muela-precio/",
  rootcanal: "/es/root-canal/",
  crown: "/es/dental-crowns/",
  whitening: "/es/cosmetica/blanqueamiento-dental-precio/",
  veneer: "/es/veneers/",
  braces: "/es/ortodoncia/",
  implant: "/es/implantes-dentales/",
  dentures: "/es/protesis/",
  allon4: "/es/all-on-4/",
};

/** Same national numbers as NATIONAL_ROWS, with Spanish labels (chart + Dataset on the ES pillar). */
export const NATIONAL_ROWS_ES: PriceRow[] = COMPARE_PROCEDURES.map(p => {
  const [low, avg, high] = nationalTriple(p.id);
  return { label: PROC_LABELS_ES[p.id] ?? p.label, low: Math.round(low), avg: Math.round(avg), high: Math.round(high) };
});
