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
async function rpc(method, params, { url = URL_, headers = {} } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
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
  assert(/Market research, not quotes, not medical advice/.test(init.result?.instructions ?? ""), "initialize returns the server instructions");

  // Scanner compatibility (OpenAI scan: 406 on Accept application/json alone, 400 on a newer protocol header).
  const CLAUDE_URL = URL_.replace(/\/mcp$/, "/claude");
  for (const url of [URL_, CLAUDE_URL]) {
    for (const version of ["2025-11-25", "2025-06-18", "2024-11-05"]) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": version },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: version, capabilities: {}, clientInfo: { name: "http-smoke", version: "0" } } }),
      });
      const b = await r.json();
      assert(r.status === 200 && b.result?.protocolVersion === version, `${url} initialize ${version} -> ${r.status} (${b.result?.protocolVersion})`);
    }
    const j = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "scan", version: "0" } } }),
    });
    assert(j.status === 200, `${url} Accept application/json alone -> ${j.status}`);
    const future = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2099-01-01" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/list", params: {} }),
    });
    assert(future.status === 200, `${url} unknown MCP-Protocol-Version header -> ${future.status}`);
  }

  const tools = await rpc("tools/list", {});
  const names = tools.result?.tools?.map((t) => t.name) ?? [];
  assert(names.length === 13, `tools/list returns 13 tools (${names.join(", ")})`);
  assert(!names.includes("out_of_pocket_estimate"), "modelled out-of-pocket tool is removed");
  assert(!names.includes("dental_cost_by_city"), "city tool is removed (E-107)");
  const WIDGET = /^ui:\/\/realdentalcosts\/(price|plan)-card-v\d+\.html$/;
  assert(
    tools.result.tools.every((t) => WIDGET.test(t._meta?.["openai/outputTemplate"] ?? "") && t._meta?.ui?.resourceUri === t._meta["openai/outputTemplate"]),
    "every tool declares a versioned widget URI (ui.resourceUri + openai/outputTemplate)",
  );
  assert(
    tools.result.tools.every((t) => t.annotations?.title === t.title && t.annotations.readOnlyHint === true && t.annotations.destructiveHint === false && t.annotations.openWorldHint === false),
    "every tool has annotations.title and boolean hints",
  );

  const resources = await rpc("resources/list", {});
  const uris = resources.result?.resources?.map((r) => r.uri) ?? [];
  const priceUri = uris.find((u) => /price-card-v\d+\.html$/.test(u));
  const planUri = uris.find((u) => /plan-card-v\d+\.html$/.test(u));
  const widget = resources.result?.resources?.find((r) => r.uri === priceUri);
  assert(widget?.mimeType === "text/html;profile=mcp-app", `resources/list declares the MCP Apps price card (${priceUri})`);
  assert(uris.length === 2, `only the current widget URIs are listed (${uris.join(", ")})`);

  const read = await rpc("resources/read", { uri: priceUri });
  const html = read.result?.contents?.[0]?.text ?? "";
  assert(html.includes("ui/notifications/tool-result") && html.includes("window.openai") && !/src=["']https?:/i.test(html), "widget HTML is self-contained, MCP Apps bridge + openai alias");
  assert(read.result?.contents?.[0]?._meta?.ui?.domain === "https://mcp.realdentalcosts.com", "/mcp widget carries _meta.ui.domain = https://mcp.realdentalcosts.com");

  for (const old of ["ui://widget/price-card.html", "ui://widget/plan-card.html", "ui://realdentalcosts/price-card-v1.html", "ui://realdentalcosts/plan-card-v1.html", "ui://realdentalcosts/plan-card-v2.html", "ui://realdentalcosts/plan-card-v3.html"]) {
    const r = await rpc("resources/read", { uri: old });
    assert(r.result?.contents?.[0]?.uri === old && r.result.contents[0].text.includes("<html"), `earlier widget URI still served: ${old}`);
  }

  const claudeRead = await rpc("resources/read", { uri: planUri }, { url: CLAUDE_URL });
  const claudeMeta = claudeRead.result?.contents?.[0]?._meta;
  assert(claudeMeta && claudeMeta.ui && claudeMeta.ui.domain === undefined, "/claude widget has no _meta.ui.domain");

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
  assert(/utm_source=chatgpt&utm_medium=mcp/.test(sc?.card?.url ?? ""), `/mcp card link carries utm_source=chatgpt (${sc?.card?.url})`);
  const claudeCall = await rpc("tools/call", { name: "medicaid_adult_dental_rules", arguments: { state: "TX" } }, { url: CLAUDE_URL });
  const claudeText = JSON.stringify(claudeCall.result?.structuredContent ?? {});
  assert(/utm_source=claude&utm_medium=mcp/.test(claudeText) && !/utm_source=(chatgpt|mcp)&/.test(claudeText), "/claude links carry utm_source=claude only");
  assert(claudeCall.result?.structuredContent?.fee_schedule?.schedule_scope === "children_only", "TX fee schedule stays children_only");
  const ohFee = await rpc("tools/call", { name: "medicaid_paid_by_code", arguments: { code: "D2740", state: "OH" } });
  const fee = ohFee.result?.structuredContent?.official_fee;
  assert(fee?.status !== "ok" || ["children_only", "not_verified"].includes(fee.schedule_scope), `official fee scope is children_only or not_verified (${fee?.schedule_scope})`);
  assert(JSON.parse(call.result.content[0].text).cashPrice.avg === avg, "text content still carries the JSON payload");

  const plan = resources.result?.resources?.find((r) => r.uri === planUri);
  assert(plan?.mimeType === "text/html;profile=mcp-app", `resources/list declares the plan-card widget (${planUri})`);

  const get = await fetch(URL_);
  assert(get.status === 405, "GET /mcp returns 405 (stateless, POST only)");

  for (const page of ["/", "/privacy", "/terms.html", "/support.html", "/docs.html", "/.well-known/openai-apps-challenge"]) {
    const r = await fetch(URL_.replace(/\/mcp$/, page));
    const body = await r.text();
    assert(r.status === 200 && (page.startsWith("/.well-known") || /realdentalcosts\.com/.test(body)), `GET ${page} serves public/ (${r.status})`);
  }
} catch (err) {
  failures++;
  console.error(`FAIL: ${err.stack ?? err}`);
} finally {
  child.kill();
}

console.log(failures ? `\n${failures} HTTP smoke check(s) failed.` : "\nAll HTTP smoke checks passed.");
process.exit(failures ? 1 : 0);
