# realdentalcosts-mcp

**A price-transparency data source for your AI assistant.** This Model Context Protocol (MCP) server gives an assistant a structured, citable dental-cost dataset: 12 common dental procedures with national figures and, for 8 of them, figures for all 51 US states (including DC), plus a line-by-line treatment-plan checker built only on sourced, dated figures.

Data comes from the **Real Dental Costs US Dental Cost Index 2026**, an openly published dataset (DOI [10.5281/zenodo.20531728](https://doi.org/10.5281/zenodo.20531728)). The data is bundled in the image: the server runs over stdio, with no API key, no network calls and no telemetry.

- Website: <https://realdentalcosts.com/>
- MCP documentation: <https://mcp.realdentalcosts.com/docs>
- Source code: <https://github.com/tresor4k/realdentalcosts-mcp>

## Run

```bash
docker run -i --rm tresor4k/realdentalcosts-mcp:latest
```

MCP client configuration (Claude Desktop, Claude Code, Cursor):

```json
{
  "mcpServers": {
    "realdentalcosts": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "tresor4k/realdentalcosts-mcp:latest"]
    }
  }
}
```

The container runs as a non-root user (uid 1000). Images: `linux/amd64` and `linux/arm64`.

## Tools (13)

- `dental_cost_by_state`: low / average / high cash price for a procedure in one US state, against the national average (crown, veneer, braces, dentures: national figures only, per-state figures not licensed for redistribution).
- `dental_national_average`: national average plus the cheapest and priciest state.
- `compare_states`: one procedure across several states (same exception).
- `benchmark_treatment_plan`: line-by-line check of a treatment plan or quote against state cash bands and Medicaid references.
- `medicaid_adult_dental_rules`: a state's adult Medicaid dental coverage rules.
- `medicaid_paid_by_code`: Medicaid amounts paid per claim line for a CDT code.
- `low_cost_dental_options`: dental schools, health centers, shortage areas and charity programs in a state or county.
- `us_dental_spending_stats`: US dental spending statistics.
- `canada_dental_cost_by_province`: dental costs by Canadian province.
- `cdcp_coverage_check`: Canadian Dental Care Plan coverage check.
- `insurance_out_of_pocket`: out-of-pocket estimate from the user's own plan figures.
- `medicare_dental_check`: Original Medicare's dental exclusion.
- `dental_program_changes`: dated changes in US public dental programs.

Every figure carries its source and period; a missing cell returns `no_source_at_this_level`, never an invented number.

## Disclaimer

Market research pricing data, not medical advice, not a quote and not a guarantee of what any dentist will charge. Always confirm pricing with a licensed dental provider. Methodology: <https://realdentalcosts.com/en/methodology/>

## License

- Code: MIT.
- Data: CC BY 4.0, attribution required (link to <https://realdentalcosts.com> or cite DOI 10.5281/zenodo.20531728).
