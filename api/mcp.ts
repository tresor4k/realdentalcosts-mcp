// Vercel Node function (not deployed): POST /api/mcp (and /mcp, /claude, see vercel.json) -> stateless
// Streamable HTTP MCP. Vercel may pre-parse the JSON body into req.body: it is passed through so the
// transport does not re-read a consumed stream. dist/ (code + data) is built by `npm run build`.
import type { IncomingMessage, ServerResponse } from "node:http";
// @ts-ignore: built JavaScript, resolved at runtime from dist/
import { handleMcp } from "../dist/http.js";

export default function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  // /claude is rewritten to /api/mcp?variant=claude (vercel.json)
  const variant = new URL(req.url ?? "/", "http://x").searchParams.get("variant") === "claude" ? "claude" : "default";
  return handleMcp(req, res, req.body, variant);
}
