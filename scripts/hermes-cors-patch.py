#!/usr/bin/env python3
"""Patch a Hermes Agent checkout so browser/WebView clients (like the Even G2 app) can use it
directly, without the proxy.

Stock hermes-agent (as of Sep 2026):
  1. builds the GET /v1/runs/{id}/events StreamResponse without CORS headers. The CORS
     middleware only decorates responses *after* the handler returns, and a streaming response
     has already sent its headers by then, so the WebView blocks the live event stream;
  2. omits X-Hermes-Session-Key from Access-Control-Allow-Headers and PATCH from
     Access-Control-Allow-Methods.

The run handlers moved from gateway/platforms/api_server.py into api_server_runs.py, which is
why the older community patch (hermes-voice-setup) reports "_handle_run_events not found" and
changes nothing. This script handles both layouts, is idempotent, keeps a one-time .bak-cors
copy, and always exits 0 so it can run as a systemd ExecStartPre.

Usage:
    python3 hermes-cors-patch.py                       # auto-detects ~/.hermes/hermes-agent
    python3 hermes-cors-patch.py /path/to/hermes-agent  # repo root or the gateway/platforms dir
    HERMES_AGENT_DIR=/opt/hermes-agent python3 hermes-cors-patch.py
"""
import os
import re
import sys

NEEDED_HEADERS = ["X-Hermes-Session-Key"]
NEEDED_METHODS = ["PATCH"]

BROKEN_RE = re.compile(
    r'(?P<indent>[ \t]*)response\s*=\s*web\.StreamResponse\(\s*status=200,\s*headers=\{\s*'
    r'"Content-Type":\s*"text/event-stream",\s*'
    r'"Cache-Control":\s*"no-cache",\s*'
    r'"X-Accel-Buffering":\s*"no",?\s*\}\s*,?\s*\)'
)

FIXED_TEMPLATE = (
    "{i}_run_sse_headers = {{\n"
    "{i}    \"Content-Type\": \"text/event-stream\", \"Cache-Control\": \"no-cache\", \"X-Accel-Buffering\": \"no\"}}\n"
    "{i}_run_origin = request.headers.get(\"Origin\", \"\")\n"
    "{i}_run_cors = self._cors_headers_for_origin(_run_origin) if _run_origin else None  # hermes-g2 cors patch\n"
    "{i}if _run_cors:\n"
    "{i}    _run_sse_headers.update(_run_cors)\n"
    "{i}response = web.StreamResponse(status=200, headers=_run_sse_headers)"
)


def find_repo(arg):
    candidates = []
    if arg:
        candidates.append(arg)
    env = os.environ.get("HERMES_AGENT_DIR")
    if env:
        candidates.append(env)
    home = os.path.expanduser("~")
    candidates += [
        os.path.join(home, ".hermes", "hermes-agent"),
        "/root/.hermes/hermes-agent",
        "/opt/hermes-agent",
        os.getcwd(),
    ]
    for c in candidates:
        c = os.path.abspath(c)
        for base in (c, os.path.join(c, "gateway", "platforms")):
            if os.path.isfile(os.path.join(base, "api_server.py")):
                return base
    return None


def patch_events(src):
    i = src.find("def _handle_run_events")
    if i == -1:
        return src, False, "not present"
    j = src.find("\ndef ", i + 1)
    j2 = src.find("\n    async def ", i + 1)
    j3 = src.find("\n    def ", i + 1)
    ends = [x for x in (j, j2, j3) if x != -1]
    j = min(ends) if ends else len(src)
    body = src[i:j]
    if "_run_cors" in body:
        return src, False, "already patched"
    m = BROKEN_RE.search(body)
    if not m:
        return src, False, "StreamResponse block not found (upstream changed?)"
    fixed = FIXED_TEMPLATE.format(i=m.group("indent"))
    body = body[: m.start()] + fixed + body[m.end():]
    return src[:i] + body + src[j:], True, "patched"


def patch_header_list(src, key, needed):
    m = re.search(r'("%s"\s*:\s*")([^"]*)(")' % key, src)
    if not m:
        return src, False, "%s not found" % key
    have = [h.strip() for h in m.group(2).split(",") if h.strip()]
    missing = [h for h in needed if h not in have]
    if not missing:
        return src, False, "ok"
    new = ", ".join(have + missing)
    return src[: m.start()] + m.group(1) + new + m.group(3) + src[m.end():], True, "added %s" % ", ".join(missing)


def rewrite(path, fn):
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
    except OSError as e:
        print("[cors-patch] cannot read %s: %s" % (path, e), file=sys.stderr)
        return
    new, changed, notes = fn(src)
    for n in notes:
        print("[cors-patch] %s: %s" % (os.path.basename(path), n))
    if not changed:
        return
    try:
        bak = path + ".bak-cors"
        if not os.path.exists(bak):
            with open(bak, "w", encoding="utf-8") as f:
                f.write(src)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new)
        print("[cors-patch] wrote %s" % path)
    except OSError as e:
        print("[cors-patch] cannot write %s: %s" % (path, e), file=sys.stderr)


def main():
    base = find_repo(sys.argv[1] if len(sys.argv) > 1 else None)
    if not base:
        print("[cors-patch] hermes-agent not found; pass its path", file=sys.stderr)
        return
    api_server = os.path.join(base, "api_server.py")
    runs = os.path.join(base, "api_server_runs.py")

    def fix_api_server(src):
        notes = []
        src, c1, n = patch_header_list(src, "Access-Control-Allow-Headers", NEEDED_HEADERS)
        notes.append("allow-headers %s" % n)
        src, c2, n = patch_header_list(src, "Access-Control-Allow-Methods", NEEDED_METHODS)
        notes.append("allow-methods %s" % n)
        c3 = False
        if "def _handle_run_events" in src and "_run_route_delegate(\"_handle_run_events\")" not in src:
            src, c3, n = patch_events(src)  # legacy layout: handler lives here
            notes.append("events CORS %s" % n)
        return src, c1 or c2 or c3, notes

    def fix_runs(src):
        src, c, n = patch_events(src)
        return src, c, ["events CORS %s" % n]

    rewrite(api_server, fix_api_server)
    if os.path.isfile(runs):
        rewrite(runs, fix_runs)
    print("[cors-patch] done — restart the gateway (systemctl restart hermes-gateway / hermes gateway restart)")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never block gateway startup
        print("[cors-patch] unexpected error: %s" % e, file=sys.stderr)
    finally:
        sys.exit(0)
