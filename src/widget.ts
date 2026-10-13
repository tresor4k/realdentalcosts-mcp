/**
 * Widgets (self-contained: no CDN, no network calls), MCP Apps format: they read the tool result from the
 * MCP Apps bridge (ui/initialize, ui/notifications/tool-result, ui/open-link: Claude, ChatGPT) or from the
 * window.openai aliases (ChatGPT). The price card renders `structuredContent.card` (built in tools.ts).
 *
 * A host caches a template by its URI: change the -vN suffix whenever a template changes. Earlier URIs
 * (ui://widget/*.html of lot 1, earlier -vN) stay served by the ResourceTemplates registered in tools.ts.
 */
export const WIDGET_URI = "ui://realdentalcosts/price-card-v2.html";
export const WIDGET_MIME = "text/html;profile=mcp-app";

// MCP Apps bridge, shared by both widgets: stores the tool result in window.__rdcData and fires "rdc:data";
// window.__rdcOpen(href) opens a link through the host. No network call.
const BRIDGE = `(function () {
  var nid = 0, initId = 0, ready = false;
  function post(m) { try { window.parent.postMessage(m, "*"); } catch (e) {} }
  function size() { if (ready) post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } }); }
  window.__rdcOpen = function (href) {
    if (window.openai && typeof window.openai.openExternal === "function") window.openai.openExternal({ href: href });
    else post({ jsonrpc: "2.0", id: ++nid, method: "ui/open-link", params: { url: href } });
  };
  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id === initId && m.result) { ready = true; post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); size(); }
    else if (m.method === "ui/notifications/tool-result" && m.params && m.params.structuredContent) {
      window.__rdcData = m.params.structuredContent;
      window.dispatchEvent(new Event("rdc:data"));
      setTimeout(size, 0);
    } else if (m.method === "ui/resource-teardown" && m.id != null) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  initId = ++nid;
  post({ jsonrpc: "2.0", id: initId, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "realdentalcosts-widget", version: "2" }, appCapabilities: {} } });
})();`;

export const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { padding: 16px; border-radius: 12px; }
  h2 { margin: 0; font-size: 16px; }
  .loc { opacity: .75; margin: 2px 0 12px; }
  .row { display: flex; gap: 8px; }
  .cell { flex: 1; padding: 10px; border-radius: 8px; background: rgba(127,127,127,.12); text-align: center; }
  .cell.mid { background: rgba(14,116,144,.18); }
  .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  .val { font-size: 18px; font-weight: 600; margin-top: 2px; }
  .note { font-size: 12px; opacity: .75; margin: 10px 0 0; }
  .disc { font-size: 12px; font-weight: 600; margin: 10px 0 0; }
  a { color: #0e7490; font-weight: 600; }
  .empty { padding: 16px; opacity: .7; }
</style>
</head>
<body>
<div id="root" class="empty">Loading dental prices…</div>
<script>
${BRIDGE}
(function () {
  var fmt = function (n) {
    return typeof n === "number" ? "$" + n.toLocaleString("en-US") : "—";
  };
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function render() {
    var out = (window.openai && window.openai.toolOutput) || window.__rdcData;
    var c = out && out.card;
    var root = document.getElementById("root");
    if (!c) return;
    root.className = "card";
    root.textContent = "";
    root.appendChild(el("h2", null, c.title));
    root.appendChild(el("div", "loc", c.location));
    var row = el("div", "row");
    [["Low", c.low, ""], [c.avgLabel || "Average", c.avg, " mid"], ["High", c.high, ""]].forEach(function (x) {
      var cell = el("div", "cell" + x[2]);
      cell.appendChild(el("div", "lbl", x[0]));
      cell.appendChild(el("div", "val", fmt(x[1])));
      row.appendChild(cell);
    });
    root.appendChild(row);
    if (c.rangeNote) root.appendChild(el("p", "note", c.rangeNote));
    root.appendChild(el("p", "disc", "Pricing research, not medical advice." + (c.disclaimer ? " " + c.disclaimer : "")));
    if (c.url) {
      var p = el("p", "note");
      var a = el("a", null, "See the full data on realdentalcosts.com");
      a.href = c.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.addEventListener("click", function (ev) {
        ev.preventDefault();
        window.__rdcOpen(c.url);
      });
      p.appendChild(a);
      root.appendChild(p);
    }
  }
  window.addEventListener("openai:set_globals", render);
  window.addEventListener("rdc:data", render);
  render();
})();
</script>
</body>
</html>
`;

/**
 * "Plan card" widget for the treatment-plan tools (benchmark_treatment_plan,
 * medicaid_adult_dental_rules, medicaid_paid_by_code, low_cost_dental_options).
 * Self-contained, textContent only (no innerHTML from data), no network calls.
 */
export const PLAN_WIDGET_URI = "ui://realdentalcosts/plan-card-v3.html";

export const PLAN_WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { padding: 14px; }
  h2 { margin: 0 0 2px; font-size: 16px; }
  h3 { margin: 14px 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; }
  .sub { opacity: .75; margin: 0 0 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid rgba(127,127,127,.25); vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; opacity: .7; }
  .b { display: inline-block; padding: 0 5px; border-radius: 6px; font-size: 10px; background: rgba(127,127,127,.18); margin-left: 3px; }
  .est { background: rgba(217,119,6,.22); }
  .obs { background: rgba(14,116,144,.22); }
  .warn { color: #b45309; }
  .ok { color: #0f766e; }
  .note { font-size: 12px; opacity: .8; margin: 6px 0 0; }
  ol { margin: 4px 0 0 18px; padding: 0; font-size: 11px; opacity: .85; word-break: break-all; }
  .disc { font-size: 12px; font-weight: 600; margin: 10px 0 0; }
  a { color: #0e7490; font-weight: 600; }
  button { margin-top: 10px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(127,127,127,.4); background: transparent; color: inherit; cursor: pointer; }
</style>
</head>
<body>
<div id="root" class="card">Loading…</div>
<script>
${BRIDGE}
(function () {
  function usd(n) { return typeof n === "number" ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function badge(t) { var cls = /estimated|derived/.test(t) ? "b est" : /observed/.test(t) ? "b obs" : "b"; return el("span", cls, t); }
  function link(href, text) {
    var a = el("a", null, text); a.href = href; a.target = "_blank"; a.rel = "noopener";
    a.addEventListener("click", function (ev) {
      ev.preventDefault(); window.__rdcOpen(href);
    });
    return a;
  }
  function pickOk(o) { return !o ? null : o.status === "ok" ? o : o.next_level && o.next_level.status === "ok" ? o.next_level : null; }
  function bandCell(b) {
    var td = el("td"), x = pickOk(b);
    if (!x) { td.appendChild(el("span", "warn", "no source")); return td; }
    td.appendChild(document.createTextNode(usd(x.low_usd) + "–" + usd(x.high_usd) + " (avg " + usd(x.avg_usd) + ")"));
    td.appendChild(badge(x.basis === "observed" ? "observed avg" : "estimated"));
    if (x.geo === "national") td.appendChild(badge("national"));
    return td;
  }
  function paidCell(m) {
    var td = el("td"), x = pickOk(m);
    if (m && m.status === "amounts_not_reliable") { td.appendChild(document.createTextNode("— ")); td.appendChild(el("span", "warn", m.reason)); return td; }
    if (!x) { td.appendChild(el("span", "warn", m && m.status === "code_required" ? "needs code" : "no source")); return td; }
    td.appendChild(document.createTextNode(usd(x.p25) + " / " + usd(x.median_cell) + " / " + usd(x.p75)));
    td.appendChild(badge((x.geo === "national" ? "national " : "") + x.period));
    if (x.quality_flag && x.quality_flag !== "ok") td.appendChild(badge(x.quality_flag));
    return td;
  }
  function feeCell(f) {
    var td = el("td");
    if (!f || f.status !== "ok") { td.appendChild(el("span", "warn", f && f.status === "code_required" ? "needs code" : "no source")); return td; }
    td.appendChild(document.createTextNode(usd(f.fee_usd) + " · " + f.effective_date));
    if (f.schedule_scope === "children_only") td.appendChild(badge("children only"));
    else if (f.schedule_scope === "not_verified") td.appendChild(badge("age scope not verified"));
    return td;
  }
  function verdict(l) {
    if (l.status === "not_covered") return "not covered by RDC data";
    var p = l.cash_band && (l.cash_band.position || (l.cash_band.next_level && l.cash_band.next_level.position));
    if (!p) return "—";
    if (p.verdict === "above_high_by_pct") return "above band +" + p.pct + "%";
    if (p.verdict === "below_low_by_pct") return "below band −" + p.pct + "%";
    if (p.verdict === "no_state_source_national_used") return "vs national: " + String(p.vs_national || "").replace(/_/g, " ");
    return p.verdict.replace(/_/g, " ");
  }
  function plan(d, root) {
    var tbl = el("table"), tr = el("tr");
    ["Line", "Quote", "Cash band", "Medicaid paid per claim line p25/med/p75 (T-MSIS)", "Fee schedule", "Verdict"].forEach(function (h) { tr.appendChild(el("th", null, h)); });
    tbl.appendChild(tr);
    d.lines.forEach(function (l) {
      var r = el("tr"), i = l.input;
      r.appendChild(el("td", null, (i.code || i.procedure) + (i.qty > 1 ? " ×" + i.qty : "") + (l.label ? " — " + l.label : "")));
      r.appendChild(el("td", null, usd(i.quoted_usd)));
      if (l.status === "not_covered") { var td = el("td", "warn", l.message); td.colSpan = 3; r.appendChild(td); }
      else if (l.status === "bundle_line") { var tb = el("td", "note", "priced in bundle: " + String(l.bundle || "").replace(/_/g, " ")); tb.colSpan = 3; r.appendChild(tb); }
      else { r.appendChild(bandCell(l.cash_band)); r.appendChild(paidCell(l.medicaid_paid)); r.appendChild(feeCell(l.fee_schedule)); }
      var v = verdict(l); r.appendChild(el("td", /above/.test(v) ? "warn" : /within/.test(v) ? "ok" : null, v));
      tbl.appendChild(r);
    });
    (d.bundles || []).forEach(function (b) {
      var r = el("tr"), q = b.quote, x = pickOk(b.cash_band);
      r.appendChild(el("td", null, "Bundle " + b.bundle.replace(/_/g, " ") + " (" + b.codes.join(" + ") + ")" + (x ? " — " + x.label : "")));
      r.appendChild(el("td", null, q ? usd(q.bundle_total_usd) + (q.units > 1 ? " (" + usd(q.per_unit_usd) + " ×" + q.units + ")" : "") : "—"));
      if (b.status === "complete" || b.status === "partial_quote") r.appendChild(bandCell(b.cash_band)); else r.appendChild(el("td", "warn", "no band"));
      var tn = el("td", "note", b.status === "complete" ? b.band_includes : b.reason + (b.missing ? " Missing: " + b.missing.join("; ") + "." : "")); tn.colSpan = 2; r.appendChild(tn);
      var bv = b.status === "complete" ? b.verdict.replace(/_/g, " ") : b.status.replace(/_/g, " ");
      r.appendChild(el("td", /above/.test(bv) ? "warn" : /within/.test(bv) ? "ok" : null, bv));
      tbl.appendChild(r);
    });
    var cr = d.city_reference;
    if (cr) {
      var rc = el("tr");
      rc.appendChild(el("td", null, "City reference — " + cr.city + (cr.label ? " — " + cr.label : "")));
      rc.appendChild(el("td", null, "—"));
      var tc = el("td", cr.status === "ok" ? null : "warn", cr.status === "ok" ? "avg " + usd(cr.avg_usd) + (cr.clinics != null ? " · " + cr.clinics + " clinics" : "") : cr.reason);
      if (cr.status === "ok") tc.appendChild(badge("observed avg"));
      tc.colSpan = 3; rc.appendChild(tc);
      rc.appendChild(el("td", "note", cr.status === "ok" ? cr.note : "state band applies"));
      tbl.appendChild(rc);
    }
    root.appendChild(tbl);
    var t = d.totals;
    root.appendChild(el("p", "note", "Quoted total " + usd(t.quoted_total_usd) + " · " + t.lines_quoted + "/" + t.lines_total + " lines quoted" + (t.above_band.length ? " · above band: " + t.above_band.join(", ") : "")));
    root.appendChild(el("p", "note", d.coverage.note));
    rule(d.medicaid_adult_rule, root);
  }
  function rule(r, root) {
    if (!r) return;
    root.appendChild(el("h3", null, "Adult Medicaid rule — " + r.state.name));
    root.appendChild(el("p", null, "Level: " + r.level.value + (r.program_summary && r.program_summary.summary ? " — " + r.program_summary.summary : "")));
    if (r.sources_disagree) root.appendChild(el("p", "note warn", r.sources_disagree));
    root.appendChild(el("p", "note", "Annual cap: " + (r.annual_cap.status !== "ok" ? "not verified" : r.annual_cap.cap_usd != null ? usd(r.annual_cap.cap_usd) + " (" + r.annual_cap.period + ")" : r.annual_cap.cap_kind.replace(/_/g, " "))));
    root.appendChild(el("p", "note", "Implants (adults): " + (r.implants.adult_21plus || r.implants.status) + " · Orthodontics (adults): " + (r.orthodontics.adult_21plus || r.orthodontics.status)));
    if (r.dentists_billing_medicaid.status === "ok") root.appendChild(el("p", "note", r.dentists_billing_medicaid.pct + "% of active dentists billed Medicaid (" + r.dentists_billing_medicaid.period + ")"));
    if (r.fee_schedule.status === "ok") root.appendChild(el("p", "note", "Fee schedule effective " + r.fee_schedule.effective_date + " · scope " + r.fee_schedule.schedule_scope));
  }
  function paid(d, root) {
    if (d.status === "not_covered") { root.appendChild(el("p", "warn", d.message)); return; }
    var n = d.national;
    root.appendChild(el("p", null, "National, paid per claim line (T-MSIS " + n.period + "): p25 " + usd(n.p25) + " · median " + usd(n.median_cell) + " · p75 " + usd(n.p75)));
    if (d.cell) {
      var c = d.cell.status === "ok" ? d.cell : null;
      root.appendChild(el("p", c ? null : "warn", c ? d.state.name + ": p25 " + usd(c.p25) + " · median " + usd(c.median_cell) + " · p75 " + usd(c.p75) + " · rank " + c.rank.rank + "/" + c.rank.of + (c.caveat ? " (" + c.caveat + ")" : "") : d.cell.status === "amounts_not_reliable" ? d.state.name + ": — " + d.cell.reason : d.state.name + ": no source at state level, national shown"));
      if (d.official_fee.status === "ok") root.appendChild(el("p", "note", "Official fee " + usd(d.official_fee.fee_usd) + " (effective " + d.official_fee.effective_date + ", scope " + d.official_fee.schedule_scope + ")"));
    }
    if (d.cash_benchmark.status === "ok") root.appendChild(el("p", "note", "National cash band " + usd(d.cash_benchmark.national_low_usd) + "–" + usd(d.cash_benchmark.national_high_usd)));
  }
  function options(d, root) {
    var s = d.dental_schools;
    root.appendChild(el("h3", null, "Dental schools"));
    if (!s.in_state.length) root.appendChild(el("p", "note", "No in-state school listed."));
    s.in_state.forEach(function (x) { var p = el("p", "note"); p.appendChild(link(x.clinic_url || x.url, x.name)); p.appendChild(document.createTextNode(" — " + x.city)); root.appendChild(p); });
    root.appendChild(el("p", "note", s.prices_note));
    var h = d.health_centers;
    root.appendChild(el("h3", null, "Health centers"));
    var p = el("p", "note", h.designated_dental_hpsas + " dental shortage-area designations (" + h.effective_date + "). ");
    if (h.find_url) p.appendChild(link(h.find_url, "Find a health center"));
    root.appendChild(p);
    if (d.county) root.appendChild(el("p", "note", d.county.status === "ok" ? d.county.county + ": " + (d.county.dental_hpsa_designations || 0) + " HPSA designation(s)" + (d.county.dental_desert ? " · dental desert" : "") : "County not found: state level shown"));
    if (d.charity && d.charity.programs) root.appendChild(el("p", "note", "Charity: " + d.charity.programs.join(" · ")));
  }
  function notes(o) {
    var seen = {}, list = [];
    (function walk(x) {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      if (typeof x.source_url === "string" && !seen[x.source_url]) { seen[x.source_url] = 1; list.push({ url: x.source_url, date: x.period || x.effective_date || x.checked_at || "" }); }
      Object.keys(x).forEach(function (k) { walk(x[k]); });
    })(o);
    return list;
  }
  function summary(d, src) {
    var out = ["Real Dental Costs — " + (d.state ? d.state.name : d.code || "")];
    if (d.lines) d.lines.forEach(function (l) {
      var m = l.medicaid_paid, s = (l.input.code || l.input.procedure) + ": " + verdict(l);
      if (m && m.status === "amounts_not_reliable") s += " · Medicaid paid per claim line: — (" + m.reason + ")";
      else if (m && m.status === "ok") s += " · Medicaid paid per claim line (T-MSIS " + m.period + ") median " + usd(m.median_cell) + (m.caveat ? " (" + m.caveat + ")" : "");
      out.push(s);
    });
    if (d.cell && d.cell.status === "amounts_not_reliable") out.push("Medicaid paid per claim line: — (" + d.cell.reason + ")");
    if (d.medicaid_adult_rule) out.push("Adult Medicaid: " + d.medicaid_adult_rule.level.value);
    src.forEach(function (s, i) { out.push("[" + (i + 1) + "] " + s.url + (s.date ? " (" + s.date + ")" : "")); });
    out.push(d.disclaimer || "");
    return out.join("\\n");
  }
  function render() {
    var d = (window.openai && window.openai.toolOutput) || window.__rdcData;
    if (!d || !d.tool) return;
    var root = document.getElementById("root");
    root.textContent = "";
    var titles = { benchmark_treatment_plan: "Treatment plan check", medicaid_adult_dental_rules: "Adult Medicaid dental rule", medicaid_paid_by_code: "Medicaid paid " + (d.code || ""), low_cost_dental_options: "Lower-cost dental options", compare_states: "States side by side", us_dental_spending_stats: "US dental spending (MEPS)", canada_dental_cost_by_province: "Dental costs by province", cdcp_coverage_check: "Canadian Dental Care Plan check", insurance_out_of_pocket: "Out-of-pocket estimate (your plan figures)", medicare_dental_check: "Medicare and dental care", dental_program_changes: "Dated dental program changes" };
    root.appendChild(el("h2", null, titles[d.tool] || "Real Dental Costs"));
    root.appendChild(el("p", "sub", (d.state ? d.state.name : d.province ? d.province.name + ", Canada" : "United States") + (d.label ? " · " + d.label : "")));
    if (d.tool === "benchmark_treatment_plan") plan(d, root);
    else if (d.tool === "medicaid_adult_dental_rules") rule(d, root);
    else if (d.tool === "medicaid_paid_by_code") paid(d, root);
    else if (d.tool === "low_cost_dental_options") options(d, root);
    var src = d.source_notes || notes(d);
    if (src.length) {
      root.appendChild(el("h3", null, "Sources"));
      var ol = el("ol");
      src.forEach(function (s) { var li = el("li"); li.appendChild(link(s.url, s.url)); if (s.date) li.appendChild(document.createTextNode(" — " + s.date)); ol.appendChild(li); });
      root.appendChild(ol);
    }
    root.appendChild(el("p", "disc", d.disclaimer || ""));
    var lk = d.links && (d.links.state || d.links.code_page);
    if (lk) { var p = el("p", "note"); p.appendChild(link(lk, "See the full data on realdentalcosts.com")); root.appendChild(p); }
    var btn = el("button", null, "Copy summary");
    btn.addEventListener("click", function () {
      if (navigator.clipboard) navigator.clipboard.writeText(summary(d, src)).then(function () { btn.textContent = "Copied"; }, function () { btn.textContent = "Copy failed"; });
    });
    root.appendChild(btn);
  }
  window.addEventListener("openai:set_globals", render);
  window.addEventListener("rdc:data", render);
  render();
})();
</script>
</body>
</html>
`;
