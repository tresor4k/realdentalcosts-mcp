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
→ California: $4,013 – $5,733 – $8,026
  National average: $3,141 – $4,489 – $6,285
  +27.7% vs. national average
```

### `dental_cost_by_city`

Average cost and clinic count for a specific city, with the parent state's
low/high range for context (the source tracks a single observed average per
city procedure — not a separate city-level min/max).

```
city: "Los Angeles"   state: "CA"
→ 567 clinics
  Implants avg $4,500 (CA range $4,013 – $8,026)
  Veneers avg $1,800 (CA range $1,075 – $2,295)
  Braces avg $5,800 (CA range $3,670 – $6,190)
```

### `out_of_pocket_estimate`

What a patient actually pays under `cash`, `insurance` (typical US PPO:
preventive ~100%, basic ~80% up to a $1,500 annual max, major/ortho ~50% up
to the same max, cosmetic/implants not covered), or `savings_plan` (~20-40%
network discount).

```
procedure: "crown"   state: "TX"   mode: "insurance"
→ List price: $445 – $1,155 – $1,780
  Estimated out-of-pocket: $223 – $578 – $890
  "Major tier: plan typically pays ~50%, up to the $1,500 annual max."
```

### `dental_national_average`

National average across all 51 states + DC, plus the cheapest and priciest
state on average.

```
procedure: "braces"
→ National average: $2,885 – $3,606 – $4,868
  Cheapest: Alabama ($3,007 avg)
  Priciest: California ($4,586 avg)
```

All four tools accept `lang: "en" | "es"` (default `"en"`) — procedure
labels, disclaimers, and Medicaid coverage notes switch to Spanish, serving
the US Hispanic market covered by the source site's `/es/` pages.

Every response includes `source` and `reference_url` fields so the numbers
stay traceable back to the published page they come from.

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

- Dataset DOI: [10.5281/zenodo.20531729](https://doi.org/10.5281/zenodo.20531729)
- Full index: <https://realdentalcosts.com/en/us-dental-cost-index/>
- Interactive state comparison: <https://realdentalcosts.com/en/compare/>
- Methodology: <https://realdentalcosts.com/en/methodology/>

State-level implant/veneer/braces prices are observed averages from the
index; other procedure prices are the national low/avg/high scaled by each
state's composite cost index. National averages are the arithmetic mean of
all 51 states (incl. DC) — never a separately invented number. No value in
this package is hand-edited or fabricated; regenerate `src/data/cities.json`
at any time with `node scripts/extract-cities.mjs <path-to-dental_costs.json>`.

## Disclaimer

This package provides **market research pricing data** — not medical advice,
not a quote, and not a guarantee of what any specific dentist will charge.
Actual prices vary by clinic, provider, insurance plan, and case complexity.
Always confirm pricing directly with a licensed dental provider before
treatment.

## License

MIT © [tresor4k](https://github.com/tresor4k)
