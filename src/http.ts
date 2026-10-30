/**
 * Streamable HTTP entry point (stateless, JSON responses) for remote clients.
 *
 * - /mcp (ChatGPT plugins, Perplexity and other clients): widgets with `_meta.ui.domain`, links utm_source=chatgpt.
 * - /claude (Claude connectors): widgets without `_meta.ui.domain`, links utm_source=claude.
 * - handleMcp(req, res, parsedBody?, variant?) is the reusable handler (api/mcp.ts on Vercel).
 * - `node dist/http.js` starts a local server on PORT (default 8787): /mcp, /claude and the static pages of public/.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";

import { createServer } from "./tools.js";

export type Variant = "default" | "claude";

function jsonRpcError(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json", ...(status === 405 ? { allow: "POST" } : {}) });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

// The SDK transport reads the raw headers too: set both views of a header.
function setHeader(req: http.IncomingMessage, name: string, value: string): void {
  req.headers[name] = value;
  const raw = req.rawHeaders;
  const kept: string[] = [];
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() !== name) kept.push(raw[i], raw[i + 1]);
  req.rawHeaders = [...kept, name, value];
}

/**
 * Hosts and scanners do not all send the headers the SDK transport checks strictly (OpenAI's plugin scan got 406
 * for an Accept of application/json alone and 400 for a newer MCP-Protocol-Version). This endpoint is stateless and
 * answers in JSON, so any client that posts JSON-RPC is served; an unknown protocol version is served as the latest
 * this server speaks (the version is negotiated in initialize anyway).
 */
export function normalizeHeaders(req: http.IncomingMessage): void {
  const accept = String(req.headers.accept ?? "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
    setHeader(req, "accept", "application/json, text/event-stream");
  const version = req.headers["mcp-protocol-version"];
  if (typeof version === "string" && !SUPPORTED_PROTOCOL_VERSIONS.includes(version))
    setHeader(req, "mcp-protocol-version", LATEST_PROTOCOL_VERSION);
}

export async function handleMcp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedBody?: unknown,
  variant: Variant = "default",
): Promise<void> {
  if (req.method !== "POST") {
    // Stateless server: no SSE stream (GET) and no session to delete (DELETE).
    jsonRpcError(res, 405, "Method not allowed: this stateless MCP endpoint only accepts POST.");
    return;
  }
  normalizeHeaders(req);
  const server = createServer(
    variant === "claude" ? { appsSdk: true, utm: "claude", uiDomain: false } : { appsSdk: true, utm: "chatgpt" },
  );
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

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", "": "text/plain; charset=utf-8" };

/** Local stand-in for Vercel's static output (cleanUrls): /privacy -> public/privacy.html. */
function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  for (const candidate of [rel, `${rel}.html`]) {
    const file = path.join(PUBLIC_DIR, candidate);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "x-robots-tag": "noindex, nofollow" });
    res.end(fs.readFileSync(file));
    return true;
  }
  return false;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT ?? 8787);
  http
    .createServer((req, res) => {
      const urlPath = (req.url ?? "/").split("?")[0];
      if (urlPath === "/mcp" || urlPath === "/claude") {
        void handleMcp(req, res, undefined, urlPath === "/claude" ? "claude" : "default");
        return;
      }
      if (req.method === "GET" && serveStatic(urlPath, res)) return;
      jsonRpcError(res, 404, "Not found: the MCP endpoint is /mcp (/claude for Claude)");
    })
    .listen(port, "127.0.0.1", () => {
      console.log(`realdentalcosts-mcp HTTP listening on http://127.0.0.1:${port}/mcp`);
    });
}
