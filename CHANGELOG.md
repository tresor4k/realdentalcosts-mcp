# Changelog

All notable changes to this project are documented here.

## [Unreleased] - lot C1 (2026-10-10, not deployed)

- 4 sourced data tools: `compare_states` (2-5 states × 1 procedure, rank among 51, gap to the national mean), `us_dental_spending_stats` (MEPS 2023 + 2024 cross-sections and the paired 2023-2024 change), `canada_dental_cost_by_province` (CSV under DOI 10.5281/zenodo.20744781, 10 provinces, territories `no_source_at_this_level`), `cdcp_coverage_check` (income tier, coverage matrix, `estimated` co-pay; income + province only).
- Canada rows hit by open data-quality issues E-081, E-086, E-087, E-090, E-094 are withheld at sync time (`data_quality: "under_review"`, no value).
- `scripts/sync-data.mjs` writes `meps.json` and `canada.json` (sha256 in the manifest); server instructions mention Canada.

## [Unreleased] - remote server, lot A (2026-10-10, not deployed)

- Remote endpoints `/mcp` (ChatGPT and other clients, widgets with `_meta.ui.domain` = `https://mcp.realdentalcosts.com`) and `/claude` (no `ui.domain`); links carry `utm_source=chatgpt`, `claude`, or `mcp` (stdio).
- `normalizeHeaders`: `Accept: application/json` alone and unknown `MCP-Protocol-Version` headers are served (200).
- Every tool: `annotations.title` + `readOnlyHint`/`destructiveHint`/`openWorldHint`; descriptions "Use this when…" with 2 EN + 2 ES phrasings and the "Do not use for" scope; server instructions. Lint: `test/descriptions.test.mjs`; golden prompts: `prompts/golden_prompts.json`.
- Widgets in MCP Apps format with versioned URIs (`ui://realdentalcosts/*-card-v2.html`); earlier URIs (`ui://widget/*.html`, `-vN`) still served through ResourceTemplates.
- Official Medicaid fee schedules: `schedule_scope` is `children_only` or `not_verified` (unknown scope), `reference_use: "context_only"`; never the reference of a quote's position.
- `vercel.json` (framework null, `public/` output, `X-Robots-Tag: noindex`) and `public/` (index, privacy, terms, support, docs, `.well-known/openai-apps-challenge` placeholder).

## [0.2.0] - 2026-07-30

### Fixed (data integrity — important)
- **All price data updated to the post-2026-07-13 rebuilt series.** Versions ≤ 0.1.1 shipped the
  pre-retraction dataset, in which veneer/braces state prices were derived from the implant series
  by a fixed multiplier and the "composite Cost Index" reduced to the implant price alone. Both were
  retracted upstream (see https://realdentalcosts.com/en/data-corrections/). The package now vendors
  the rebuilt `compare-data` (observed state averages: implant = Real Dental Costs series, DOI
  10.5281/zenodo.20531728; crown/veneer/braces/dentures = ASQ360/CareCredit 2023-2024), with a
  `basis` field per procedure.
- Braces national average corrected from the retracted $3,606 to the observed $6,352; braces
  cheapest/priciest states are now the real observed ones (Indiana / Nevada), no longer a clone of
  the implant ranking.
- Index renamed to what it measures: `restorativeCostIndex` (valid only for implant/crown/denture),
  with an explanatory `indexNote` in responses (rebased: 100 = national observed implant average).

### Changed
- `dental_cost_by_city` now serves the **implant series only** — the only series published at city
  level upstream (open dataset, DOI 10.5281/zenodo.20819438). Per-city veneer/braces figures were
  retired in the source site's July 2026 data-integrity work. `cities.json` is now extracted from
  the published `us-dental-cost-by-city-2026.csv` instead of the internal `dental_costs.json`.
- `dental_national_average` no longer reports a fake cheapest/priciest state for `national`-basis
  (cosmetic) procedures with no state variation.
- Responses now include `basis` + `basisNote` (provenance per procedure, EN/ES) and an `api_url`
  pointing to the matching endpoint of the new open JSON API (https://realdentalcosts.com/en/api/).

## [0.1.0] - 2026-07-03

### Added
- Initial release.
- `dental_cost_by_state` — low/avg/high cash price for a procedure in a US state, vs. national average.
- `dental_cost_by_city` — city-level average cost and clinic count, with parent-state range for context.
- `out_of_pocket_estimate` — cash / insurance / dental-savings-plan out-of-pocket estimate.
- `dental_national_average` — 51-state (incl. DC) national average, cheapest/priciest state.
- Bilingual responses (`lang: "en" | "es"`).
- Data: 12 procedures x 51 states (incl. DC) + 206 cities, from the Real Dental Costs US Dental Cost Index 2026.
