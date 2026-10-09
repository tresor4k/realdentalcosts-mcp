#!/usr/bin/env node
/**
 * realdentalcosts-mcp — stdio MCP server exposing US dental cost lookups
 * backed by the Real Dental Costs US Dental Cost Index 2026 dataset.
 *
 * Tools: dental_cost_by_state, dental_cost_by_city, dental_national_average,
 * plus the treatment-plan tools (registered in ./tools.ts).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer } from "./tools.js";
import { loadCitiesData } from "./lib/cities.js";

const server = createServer();

// Touch loadCitiesData at startup so a missing/corrupt data file fails fast
// with a clear error instead of on the first tool call.
loadCitiesData();

const transport = new StdioServerTransport();
await server.connect(transport);
