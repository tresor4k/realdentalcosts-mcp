# Changelog

All notable changes to this project are documented here.

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
