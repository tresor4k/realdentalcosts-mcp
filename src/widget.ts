/**
 * ChatGPT Apps SDK widget (self-contained: no CDN, no network calls).
 * Reads `window.openai.toolOutput.card` (the structuredContent built in
 * tools.ts) and renders the low / average / high price range.
 */
export const WIDGET_URI = "ui://widget/price-card.html";
export const WIDGET_MIME = "text/html+skybridge";

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
    var out = window.openai && window.openai.toolOutput;
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
        if (window.openai && typeof window.openai.openExternal === "function") {
          ev.preventDefault();
          window.openai.openExternal({ href: c.url });
        }
      });
      p.appendChild(a);
      root.appendChild(p);
    }
  }
  window.addEventListener("openai:set_globals", render);
  render();
})();
</script>
</body>
</html>
`;
