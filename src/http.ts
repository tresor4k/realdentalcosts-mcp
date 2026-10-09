/**
 * Streamable HTTP entry point (stateless, JSON responses) for remote clients:
 * ChatGPT Apps SDK / connectors and Claude custom connectors.
 *
 * - handleMcp(req, res, parsedBody?) is the reusable handler (api/mcp.ts).
 * - handlePrivacy(req, res) serves the static privacy page (GET /privacy).
 * - `node dist/http.js` starts a local server on PORT (default 8787) at /mcp and /privacy.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { createServer } from "./tools.js";
import { loadCitiesData } from "./lib/cities.js";

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json", ...(status === 405 ? { allow: "POST" } : {}) });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

export async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no SSE stream (GET) and no session to delete (DELETE).
    jsonRpcError(res, 405, "Method not allowed: this stateless MCP endpoint only accepts POST.");
    return;
  }
  const server = createServer({ appsSdk: true });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    if (!res.headersSent) jsonRpcError(res, 500, `Internal error: ${(err as Error).message}`);
  }
}

export default handleMcp;

export const PRIVACY_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy — Real Dental Costs app (MCP)</title>
<style>body{max-width:720px;margin:32px auto;padding:0 16px;font:15px/1.6 system-ui,sans-serif}h1{font-size:22px}</style>
</head><body>
<h1>Privacy — Real Dental Costs app and connector</h1>
<p>Last updated: 2026-10-09. Operator: Real Dental Costs (https://realdentalcosts.com).</p>
<h2>What the app receives</h2>
<p>Only the arguments of each tool call: CDT procedure codes or procedure names, quantities, quoted prices in USD,
a US state code, an optional county name, a coverage category (none, adult Medicaid, private, Medicare Advantage,
discount plan) and a language (en/es). The app never asks for a name, age, date of birth, ZIP code, address,
insurer or plan name, member ID, phone number or email.</p>
<h2>What is stored</h2>
<p>Nothing. Requests are processed in memory to look up published figures and the response is returned; tool
arguments, quoted prices and responses are not saved, sold or shared. There are no cookies, accounts or trackers.</p>
<h2>Usage log</h2>
<p>An aggregate usage log records only the tool name and the UTC day of each call. It contains no tool arguments,
no IP address, no user agent and no other personal data.</p>
<h2>Data shown</h2>
<p>Published market-research figures (cash price bands, Medicaid paid per claim line from T-MSIS, official fee
schedules, program rules), each with its source URL and period. Pricing research, not medical, dental, coding or
insurance advice.</p>
<h2>Contact</h2>
<p>research@realdentalcosts.com</p>
</body></html>
`;

export function handlePrivacy(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" });
  res.end(PRIVACY_HTML);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadCitiesData();
  const port = Number(process.env.PORT ?? 8787);
  http
    .createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/privacy" && req.method === "GET") {
        handlePrivacy(req, res);
        return;
      }
      if (path !== "/mcp") {
        jsonRpcError(res, 404, "Not found: MCP endpoint is /mcp");
        return;
      }
      void handleMcp(req, res);
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`realdentalcosts-mcp HTTP listening on http://127.0.0.1:${port}/mcp`);
    });
}
