#!/usr/bin/env node
/**
 * Local smoke test for the Streamable HTTP entry point (dist/http.js).
 * Starts the server on a local port, sends raw JSON-RPC requests
 * (initialize, tools/list, resources/list, resources/read, tools/call),
 * prints the responses and checks the Apps SDK fields. Expected prices are
 * loaded from the compiled data, never hand-typed.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { COMPARE_PRICES } = await import(pathToFileURL(path.join(root, "dist", "lib", "compare-data.js")));
const PORT = Number(process.env.PORT ?? 8799);
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

const child = spawn(process.execPath, [path.join(root, "dist", "http.js")], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => String(d).includes("listening") && resolve());
  child.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
  setTimeout(() => reject(new Error("server start timeout")), 10000);
});

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) failures++;
  console.log(`${cond ? "OK" : "FAIL"}: ${msg}`);
};

let id = 0;
async function rpc(method, params) {
  const res = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json();
  const text = JSON.stringify(body, null, 2);
  console.log(`\n=== ${method} (HTTP ${res.status}) ===\n${text.length > 1800 ? text.slice(0, 1800) + "\n… [truncated]" : text}`);
  return body;
}

try {
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-smoke", version: "0.0.0" },
  });
  assert(init.result?.serverInfo?.name === "realdentalcosts-mcp", "initialize returns serverInfo");

  const tools = await rpc("tools/list", {});
  const names = tools.result?.tools?.map((t) => t.name) ?? [];
  assert(names.length === 7, `tools/list returns 7 tools (${names.join(", ")})`);
  assert(!names.includes("out_of_pocket_estimate"), "modelled out-of-pocket tool is removed");
  assert(
    tools.result.tools.every((t) => /^ui:\/\/widget\/(price|plan)-card\.html$/.test(t._meta?.["openai/outputTemplate"] ?? "")),
    "every tool declares openai/outputTemplate",
  );

  const resources = await rpc("resources/list", {});
  const widget = resources.result?.resources?.find((r) => r.uri === "ui://widget/price-card.html");
  assert(widget?.mimeType === "text/html+skybridge", "resources/list declares the skybridge widget");

  const read = await rpc("resources/read", { uri: "ui://widget/price-card.html" });
  const html = read.result?.contents?.[0]?.text ?? "";
  assert(html.includes("window.openai") && !/src=["']https?:/i.test(html), "widget HTML is self-contained (no external src)");

  const call = await rpc("tools/call", {
    name: "dental_cost_by_state",
    arguments: { procedure: "implant", state: "TX" },
  });
  const sc = call.result?.structuredContent;
  const [low, avg, high] = COMPARE_PRICES.TX.implant;
  assert(
    sc?.card?.low === low && sc.card.avg === avg && sc.card.high === high,
    `tools/call TX implant card = ${low}/${avg}/${high}`,
  );
  assert(/utm_source=chatgpt-app&utm_medium=mcp/.test(sc?.card?.url ?? ""), `card link carries UTM (${sc?.card?.url})`);
  assert(JSON.parse(call.result.content[0].text).cashPrice.avg === avg, "text content still carries the JSON payload");

  const plan = resources.result?.resources?.find((r) => r.uri === "ui://widget/plan-card.html");
  assert(plan?.mimeType === "text/html+skybridge", "resources/list declares the plan-card widget");

  const get = await fetch(URL_);
  assert(get.status === 405, "GET /mcp returns 405 (stateless, POST only)");

  const priv = await fetch(URL_.replace(/\/mcp$/, "/privacy"));
  const privHtml = await priv.text();
  assert(priv.status === 200 && /Nothing\. Requests are processed in memory/.test(privHtml), "GET /privacy serves the static privacy page");
} catch (err) {
  failures++;
  console.error(`FAIL: ${err.stack ?? err}`);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} HTTP smoke check(s) failed.` : "\nAll HTTP smoke checks passed.");
process.exit(failures ? 1 : 0);
