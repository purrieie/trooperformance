#!/usr/bin/env python3
"""Build the troopod.io/trooperformance/ copy of this site.

    python3 tools/troopod-io/build.py ~/introusa/public/trooperformance [~/introusa/index.html]

Output layout (served by troopod.io's nginx straight from public/):
    /trooperformance/              landing   (design/v2/Landing.dc.html + support.js + morphdom)
    /trooperformance/audit.html    scan + report
    /trooperformance/assets/...    css, js, logos, email images
Links are rewritten for that layout, the GitHub Pages "noindex" comes off the landing, canonical/og point at troopod.io,
and troopod.io's own cookie-consent + Google Tag Manager block (read from introusa/index.html) is added to both pages.
Re-run after any change here, then commit the folder in introusa.
"""
import os, re, shutil, sys

SRC = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.abspath(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/introusa/public/trooperformance"))
SITE_INDEX = os.path.abspath(os.path.expanduser(sys.argv[2] if len(sys.argv) > 2 else os.path.join(OUT, "..", "..", "index.html")))
BASE = "https://troopod.io/trooperformance/"


def read(p):
    with open(p, encoding="utf-8") as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(s)


def must(s, a, b, n=None):
    c = s.count(a)
    if c == 0 or (n is not None and c != n):
        raise SystemExit(f"build: expected {n or 'some'} of {a[:60]!r}, found {c}")
    return s.replace(a, b)


# troopod.io's consent + GTM block, copied from the live site's index.html so the two never drift
site = read(SITE_INDEX)
m = re.search(r"(<!-- Cookie Consent:.*?<!-- End Google Tag Manager -->)", site, re.S)
n = re.search(r"(<!-- Google Tag Manager \(noscript\) -->.*?<!-- End Google Tag Manager \(noscript\) -->)", site, re.S)
if not m or not n:
    raise SystemExit("build: couldn't find the Cookie Consent / GTM block in " + SITE_INDEX)
HEAD_TAGS, BODY_TAGS = m.group(1), n.group(1)

if os.path.isdir(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

# assets
shutil.copytree(os.path.join(SRC, "assets"), os.path.join(OUT, "assets"), ignore=shutil.ignore_patterns(".DS_Store"))
shutil.copy(os.path.join(SRC, "favicon.svg"), OUT)
for f in ("support.js", "morphdom-umd.min.js"):
    shutil.copy(os.path.join(SRC, "design", "v2", f), OUT)

# landing -> index.html
L = read(os.path.join(SRC, "design", "v2", "Landing.dc.html"))
L = must(L, '"../../assets/', '"assets/')
L = must(L, '"../../audit.html?url="', '"audit.html?url="', 1)
L = must(L, '<meta name="robots" content="noindex">\n', "", 1)
L = must(L, "<title>", (
    f'<link rel="canonical" href="{BASE}">\n'
    '<link rel="icon" href="favicon.svg" type="image/svg+xml">\n'
    '<meta name="description" content="Free performance, SEO and AI audit for your website. See your score, what is slowing you down and what a faster site is worth.">\n'
    '<meta property="og:type" content="website">\n'
    f'<meta property="og:url" content="{BASE}">\n'
    '<meta property="og:title" content="TrooPerformance: free speed, SEO and AI audit">\n'
    f'<meta property="og:image" content="{BASE}assets/og.png">\n'
    + HEAD_TAGS + "\n<title>"), 1)
L = must(L, "<body>", "<body>\n" + BODY_TAGS, 1)
write(os.path.join(OUT, "index.html"), L)

# audit page
A = read(os.path.join(SRC, "audit.html"))
A = must(A, 'href="https://purrieie.github.io/trooperformance/"', f'href="{BASE}"')
A = must(A, "https://purrieie.github.io/trooperformance/assets/og.png", f"{BASE}assets/og.png")
A = must(A, 'href="design/"', 'href="./"')
A = must(A, "<title>", HEAD_TAGS + "\n<title>", 1)
A = must(A, "<body>", "<body>\n" + BODY_TAGS, 1)
write(os.path.join(OUT, "audit.html"), A)

# audit.js: no-URL visits go back to the landing in this folder
J = read(os.path.join(OUT, "assets", "js", "audit.js"))
J = must(J, 'location.replace("design/")', 'location.replace("./")', 1)
write(os.path.join(OUT, "assets", "js", "audit.js"), J)

left = [f for f in ("index.html", "audit.html") if "purrieie.github.io/trooperformance" in read(os.path.join(OUT, f))]
size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(OUT) for f in fs)
print(f"built {OUT}  ({size // 1024} KB)" + (f"  WARNING still pointing at GitHub Pages: {left}" if left else ""))
