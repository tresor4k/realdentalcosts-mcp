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
  WITHHELD_SERIES,
} from "./compare-data.js";

/** Minimal inlined shape of the upstream `PriceRow` type (jsonld.ts, not vendored here). */
export interface PriceRow {
  label: string;
  low: number;
  avg: number;
  high: number;
}

/** USD formatter shared across the cost tools. */
export const fmtUsd = (n: number) => "$" + Math.round(n).toLocaleString("en-US");

/** Arithmetic mean of the [low, avg, high] cash triple across all 51 states + DC. */
export function nationalTriple(procId: string): [number, number, number] {
  // E-110: no state table in this package; the national band published by API v1 (same rounded values).
  if (WITHHELD_SERIES[procId]) return WITHHELD_SERIES[procId].national;
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
 * the 51 state + DC figures. Feeds the Dataset JSON-LD and the static
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
