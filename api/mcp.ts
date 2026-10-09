/**
 * Vercel Node function (NOT deployed): POST /api/mcp -> stateless Streamable HTTP MCP.
 * Vercel may pre-parse the JSON body into req.body; pass it through so the
 * transport does not try to re-read a consumed stream.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleMcp } from "../src/http.js";

export default function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  return handleMcp(req, res, req.body);
}
