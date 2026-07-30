# realdentalcosts-mcp

[![npm version](https://img.shields.io/npm/v/realdentalcosts-mcp.svg)](https://www.npmjs.com/package/realdentalcosts-mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**A price-transparency data source for your AI assistant.** Most dental-cost
numbers floating around the web are guesses, ad copy, or averages nobody can
trace back to a source. This server hands your assistant a structured,
citable dataset instead: 12 common dental procedures, priced across all 51
US states (including DC) and 200+ cities, plus the insurance-coverage math
that turns a list price into what a patient actually pays out of pocket.

Data comes from the **Real Dental Costs US Dental Cost Index 2026** — an
openly published dataset (DOI below), not a scrape or an estimate pulled from
thin air.

## Quick Start

No installation needed — run directly with `npx`.

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "realdentalcosts": {
      "command": "npx",
      "args": ["-y", "realdentalcosts-mcp"]
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "realdentalcosts": {
      "command": "npx",
      "args": ["-y", "realdentalcosts-mcp"]
    }
  }
}
```

Restart your client after saving. The server runs entirely offline over
stdio — no API key, no network calls, no telemetry.

## Tools

### `dental_cost_by_state`

Low/average/high cash price for a procedure in one US state, benchmarked
against the national average and the state's dental cost index.

```
procedure: "implant"   state: "CA"
→ California: $4,780 – $5,733 – $7,290 (observed state average, modelled band)
  National average: $3,760 – $4,507 – $5,733
  +27.2% vs. national average · Restorative Cost Index 127
```

### `dental_cost_by_city`

Observed average single-implant cost and clinic count for a specific city
(206 cities, open dataset DOI 10.5281/zenodo.20819438), with the parent
state's implant band for context. Only the implant series is published at
city level — per-city veneer/braces figures were retired in the source
site's July 2026 data-integrity work.

```
city: "Los Angeles"   state: "CA"
→ 567 clinics
  Implants avg $4,500 (CA implant band $4,780 – $7,290)
```

### `out_of_pocket_estimate`

What a patient actually pays under `cash`, `insurance` (typical US PPO:
preventive ~100%, basic ~80% up to a $1,500 annual max, major/ortho ~50% up
to the same max, cosmetic/implants not covered), or `savings_plan` (~20-40%
network discount).

```
procedure: "crown"   state: "TX"   mode: "insurance"
→ List price: $955 – $1,250 – $2,130
  Estimated out-of-pocket: $478 – $625 – $1,065
  "Major tier: plan typically pays ~50%, up to the $1,500 annual max."
```

### `dental_national_average`

National average across all 51 states + DC, plus the cheapest and priciest
state on average.

```
procedure: "braces"
→ National average: $2,503 – $6,352 – $10,014
  Cheapest: Indiana ($4,767 avg)
  Priciest: Nevada ($8,350 avg)
```

All four tools accept `lang: "en" | "es"` (default `"en"`) — procedure
labels, disclaimers, and Medicaid coverage notes switch to Spanish, serving
the US Hispanic market covered by the source site's `/es/` pages.

Every response includes `source`, `reference_url` and `api_url` fields plus a
per-procedure `basis` (`observed` / `estimated` / `national`) with a provenance
note, so the numbers stay traceable back to the published data they come from.

## Open JSON API (no MCP required)

The same data this MCP server exposes is also available as a **free, open JSON API** —
static versioned endpoints, no key, CORS enabled, documented with an OpenAPI 3.1 spec:

- Docs: <https://realdentalcosts.com/en/api/>
- Metadata & DOIs: <https://realdentalcosts.com/api/v1/index/meta.json>
- All 51 state markets: <https://realdentalcosts.com/api/v1/states.json>
- One state: <https://realdentalcosts.com/api/v1/state/tx.json>
- The 12 procedures: <https://realdentalcosts.com/api/v1/procedures.json>
- One procedure across states: <https://realdentalcosts.com/api/v1/procedure/dental-implant.json>
- OpenAPI 3.1 spec: <https://realdentalcosts.com/api/v1/openapi.json>

License **CC BY 4.0** — attribution required: link to <https://realdentalcosts.com> or cite
DOI [10.5281/zenodo.20531728](https://doi.org/10.5281/zenodo.20531728).

## Data & methodology

Data is derived from the **US Dental Cost Index 2026**, an open dataset
published by [Real Dental Costs](https://realdentalcosts.com):

- Dataset concept DOI: [10.5281/zenodo.20531728](https://doi.org/10.5281/zenodo.20531728)
- Full index: <https://realdentalcosts.com/en/us-dental-cost-index/>
- Interactive state comparison: <https://realdentalcosts.com/en/compare/>
- Methodology: <https://realdentalcosts.com/en/methodology/>

Every procedure carries a `basis` field. `observed` state averages are
measured prices (implant = Real Dental Costs' own observed series;
crown/veneer/braces/dentures = ASQ360/CareCredit Average Procedural Cost
Study 2023-2024), with the low/high band around them modelled from national
ratios. `estimated` procedures have no per-state source: the national figure
is scaled by the state's Restorative Cost Index, which is valid only for
restorative work (implant/crown/denture — it does not predict orthodontic or
cosmetic prices). `national` (cosmetic) procedures carry no invented state
variation. National averages are the arithmetic mean of all 51 states
(incl. DC) — never a separately invented number. No value in this package is
hand-edited or fabricated; regenerate `src/data/cities.json` at any time with
`node scripts/extract-cities.mjs <path-to-us-dental-cost-by-city-2026.csv>`.

## Disclaimer

This package provides **market research pricing data** — not medical advice,
not a quote, and not a guarantee of what any specific dentist will charge.
Actual prices vary by clinic, provider, insurance plan, and case complexity.
Always confirm pricing directly with a licensed dental provider before
treatment.

## License

MIT © [tresor4k](https://github.com/tresor4k)
