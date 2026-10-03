"""Export Opera cookies for allow-listed domains, in Playwright addCookies shape, for Muster's research browser.

Usage: python opera-cookies.py reddit.com [linkedin.com ...]

Run by src/browser/opera.ts with Agent Reach's python (it has browser_cookie3). Prints one JSON object on
stdout: {"cookies": [...], "counts": {"reddit.com": 10}, "errors": {"g2.com": "..."}}. Cookie values go
to stdout only; nothing here logs or writes them anywhere. Opera keeps its key under DPAPI (no app-bound
key), so no admin rights are needed. The database is read in place: copying it fails while Opera runs.
"""
import json
import os
import re
import sys

DOMAIN = re.compile(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$")


def opera_dir():
    override = os.environ.get("MUSTER_OPERA_DIR")
    if override:
        return override
    return os.path.join(os.environ.get("APPDATA", ""), "Opera Software", "Opera Stable")


def matches(host, domain):
    host = host.lower().lstrip(".")
    return host == domain or host.endswith("." + domain)


def to_playwright(c):
    rest = getattr(c, "_rest", {}) or {}
    http_only = any(k.lower() == "httponly" for k in rest)
    expires = c.expires if isinstance(c.expires, (int, float)) and c.expires > 0 else -1
    return {
        "name": c.name,
        "value": c.value or "",
        "domain": c.domain,
        "path": c.path or "/",
        "expires": expires,
        "httpOnly": http_only,
        "secure": bool(c.secure),
        "sameSite": "Lax",
    }


def main(argv):
    domains = []
    for a in argv:
        d = a.strip().lower()
        if not DOMAIN.match(d):
            print(json.dumps({"cookies": [], "counts": {}, "errors": {a: "not a domain"}}))
            return 2
        domains.append(d)
    base = opera_dir()
    cookie_file = os.path.join(base, "Default", "Network", "Cookies")
    if not os.path.exists(cookie_file):
        cookie_file = os.path.join(base, "Network", "Cookies")  # older single-profile layout
    key_file = os.path.join(base, "Local State")
    out = {"cookies": [], "counts": {}, "errors": {}}
    try:
        import browser_cookie3
    except ImportError:
        out["errors"]["*"] = "browser_cookie3 is not installed in this python"
        print(json.dumps(out))
        return 1
    if not os.path.exists(cookie_file) or not os.path.exists(key_file):
        out["errors"]["*"] = "Opera profile not found"
        print(json.dumps(out))
        return 1
    for d in domains:
        try:
            jar = browser_cookie3.opera(cookie_file=cookie_file, key_file=key_file, domain_name=d)
            got = [to_playwright(c) for c in jar if matches(c.domain, d)]
            out["cookies"].extend(got)
            out["counts"][d] = len(got)
        except Exception as e:  # the message never carries cookie values
            out["errors"][d] = type(e).__name__ + ": " + str(e)[:200]
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
