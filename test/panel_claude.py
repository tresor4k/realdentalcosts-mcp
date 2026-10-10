import json, subprocess, shutil, sys, os
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = json.load(open(os.path.join(ROOT, "prompts", "golden_prompts.json"), encoding="utf-8"))["prompts"]
CLAUDE = shutil.which("claude")

def pick(tool, kind, n):
    xs = sorted([p for p in P if p["for_tool"] == tool and p["kind"] == kind], key=lambda p: p["id"])
    en = [p for p in xs if p["lang"] == "en"]; es = [p for p in xs if p["lang"] == "es"]
    out = []
    while len(out) < n and (en or es):
        for pool in (en, es):
            if pool and len(out) < n: out.append(pool.pop(0))
    return out

def run(p):
    cmd = [CLAUDE, "-p", "--mcp-config", "test/panel-mcp.json", "--strict-mcp-config", "--model", "sonnet",
           "--allowedTools", "mcp__realdentalcosts__*", "--disallowedTools", "WebSearch,WebFetch",
           "--output-format", "stream-json", "--verbose"]
    called, err = None, None
    try:
        r = subprocess.run(cmd, input=p["prompt"], capture_output=True, text=True, encoding="utf-8", timeout=120, cwd=ROOT)
        for line in r.stdout.splitlines():
            try: e = json.loads(line)
            except Exception: continue
            if e.get("type") == "assistant":
                for c in e["message"].get("content", []):
                    if c.get("type") == "tool_use" and c["name"].startswith("mcp__realdentalcosts__"):
                        called = called or c["name"].split("__", 2)[2]
        if r.returncode != 0 and called is None and not r.stdout: err = r.stderr[:200]
    except subprocess.TimeoutExpired:
        err = "timeout"
    exp = p["expected_tool"]
    ok = (called == exp) if p["kind"] == "indirect" else (called is None)
    return {"id": p["id"], "tool": p["for_tool"], "kind": p["kind"], "lang": p["lang"], "prompt": p["prompt"],
            "expected": exp, "called": called, "ok": ok, "error": err}

tools = sorted({p["for_tool"] for p in P})
sel = [p for t in tools for p in pick(t, "indirect", 3) + pick(t, "negative", 2)]
with ThreadPoolExecutor(4) as ex: res = list(ex.map(run, sel))
json.dump(res, open(os.path.join(ROOT, "test", "panel-claude-2026-10-10.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
for t in tools:
    for k in ("indirect", "negative"):
        r = [x for x in res if x["tool"] == t and x["kind"] == k]
        print(f"{t:35} {k:9} {sum(x['ok'] for x in r)}/{len(r)}")
for k in ("indirect", "negative"):
    r = [x for x in res if x["kind"] == k]; print(k, sum(x["ok"] for x in r), "/", len(r))
for x in res:
    if not x["ok"]: print("FAIL", x["id"], x["expected"], "->", x["called"], x["error"] or "")
