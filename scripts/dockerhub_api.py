# -*- coding: utf-8 -*-
"""Docker Hub API for tresor4k/realdentalcosts-mcp. The token is read at run time from
~/.claude/credentials/dockerhub-tresor4k.txt (never stored here, never printed).
Usage: dockerhub_api.py check | describe [long.md] [short.txt] | show
Defaults for describe: docker/DOCKERHUB.md and docker/DOCKERHUB-short.txt."""
import json, os, sys, urllib.request, urllib.error

USER, REPO = "tresor4k", "realdentalcosts-mcp"
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PAT = open(os.path.join(os.path.expanduser("~"), ".claude", "credentials", "dockerhub-tresor4k.txt"), encoding="utf-8").read().strip()


def call(method, url, body=None, jwt=None):
    h = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "realdentalcosts-mcp-publish"}
    if jwt:
        h["Authorization"] = "Bearer " + jwt
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            t = r.read().decode()
            return r.status, (json.loads(t) if t else None)
    except urllib.error.HTTPError as e:
        t = e.read().decode("utf-8", "replace").replace(PAT, "***")
        return e.code, t[:200]


def login():
    st, r = call("POST", "https://hub.docker.com/v2/users/login", {"username": USER, "password": PAT})
    print("login:", st, "session token received" if isinstance(r, dict) and r.get("token") else r)
    return r["token"] if isinstance(r, dict) else None


mode = sys.argv[1]
jwt = login()
if not jwt:
    sys.exit(1)
base = "https://hub.docker.com/v2/repositories/%s/%s/" % (USER, REPO)
if mode == "check":
    st, r = call("GET", base, jwt=jwt)
    print("repo:", st, {k: r.get(k) for k in ("name", "is_private", "description", "pull_count")} if isinstance(r, dict) else r)
    st, r = call("GET", "https://hub.docker.com/v2/repositories/%s/?page_size=25" % USER, jwt=jwt)
    print("account repos:", st, [x["name"] for x in r.get("results", [])] if isinstance(r, dict) else r)
elif mode == "describe":
    full = open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "docker", "DOCKERHUB.md"), encoding="utf-8").read()
    short = open(sys.argv[3] if len(sys.argv) > 3 else os.path.join(ROOT, "docker", "DOCKERHUB-short.txt"), encoding="utf-8").read().strip()
    assert len(short) <= 100, len(short)
    st, r = call("PATCH", base, {"description": short, "full_description": full}, jwt=jwt)
    print("description:", st, {k: (r.get(k) or "")[:80] for k in ("description",)} if isinstance(r, dict) else r,
          "| full length:", len(r.get("full_description") or "") if isinstance(r, dict) else "-")
elif mode == "show":
    st, r = call("GET", base, jwt=jwt)
    print(st, {k: r.get(k) for k in ("name", "namespace", "is_private", "description", "last_updated", "pull_count", "status_description")} if isinstance(r, dict) else r)
    st, t = call("GET", base + "tags/?page_size=10", jwt=jwt)
    print("tags:", [(x["name"], x.get("full_size")) for x in t.get("results", [])] if isinstance(t, dict) else t)
