// TrooPerformance site audit API (Supabase Edge Function, Deno).
// GET  /psi?url=...&strategy=mobile|desktop  -> trimmed Google PageSpeed Insights result (needs PSI_API_KEY secret)
// POST /scan {url}                             -> Search (SEO) + AI answers (AEO) checks from raw HTML, robots.txt, sitemap, llms.txt
// Public, no auth. Read-only: it only fetches public pages.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MAX_BYTES = 3_000_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- URL safety ----------
function safeUrl(raw: string): URL | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!okHost(u.hostname)) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  u.hash = "";
  return u;
}
function okHost(h: string): boolean {
  h = h.toLowerCase();
  if (!h.includes(".")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[")) return false;
  if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return false;
  return true;
}

async function get(url: string, timeoutMs = 15000): Promise<{ ok: boolean; status: number; url: string; text: string; ms: number; headers: Headers | null }> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.8", "accept-language": "en-IN,en;q=0.9" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const final = r.url || url;
    try { if (!okHost(new URL(final).hostname)) return { ok: false, status: 0, url: final, text: "", ms: Date.now() - t0, headers: null }; } catch { /* ignore */ }
    const buf = new Uint8Array(await r.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.length > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
    return { ok: r.ok, status: r.status, url: final, text, ms: Date.now() - t0, headers: r.headers };
  } catch {
    return { ok: false, status: 0, url, text: "", ms: Date.now() - t0, headers: null };
  }
}

// ---------- robots.txt ----------
type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[] };
function parseRobots(txt: string) {
  const groups: Group[] = [];
  const sitemaps: string[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (cur) cur.rules.push({ allow: key === "allow", path: val });
      lastWasAgent = false;
    } else if (key === "sitemap") {
      sitemaps.push(val);
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}
function rulesFor(groups: Group[], bot: string): { rules: Rule[]; matched: string } {
  const b = bot.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(b));
  if (own.length) return { rules: own.flatMap((g) => g.rules), matched: bot };
  const star = groups.filter((g) => g.agents.includes("*"));
  return { rules: star.flatMap((g) => g.rules), matched: star.length ? "*" : "" };
}
function allowed(rules: Rule[], path: string): { ok: boolean; rule: string } {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!r.path) continue;
    const re = new RegExp("^" + r.path.replace(/[.+?^{}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$|\$$/, "$"));
    if (re.test(path)) {
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return best ? { ok: best.allow, rule: (best.allow ? "Allow: " : "Disallow: ") + best.path } : { ok: true, rule: "" };
}
const BOTS = [
  { ua: "OAI-SearchBot", who: "ChatGPT search" },
  { ua: "GPTBot", who: "OpenAI training" },
  { ua: "ChatGPT-User", who: "ChatGPT browsing" },
  { ua: "PerplexityBot", who: "Perplexity" },
  { ua: "ClaudeBot", who: "Claude" },
  { ua: "Google-Extended", who: "Gemini" },
  { ua: "Applebot-Extended", who: "Apple Intelligence" },
  { ua: "Googlebot", who: "Google Search" },
  { ua: "Bingbot", who: "Bing + Copilot" },
];

// ---------- HTML helpers ----------
function decode(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&rsquo;|&lsquo;/g, "'").replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&ndash;/g, "–").replace(/&mdash;/g, "—").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9-]+/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}
function visibleText(html: string): string {
  const body = (html.match(/<body[\s\S]*$/i) || [html])[0];
  return decode(
    body
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}
function flattenLd(node: unknown, out: Record<string, unknown>[]) {
  if (Array.isArray(node)) { node.forEach((n) => flattenLd(n, out)); return; }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o["@graph"]) flattenLd(o["@graph"], out);
    if (o["@type"]) out.push(o);
    for (const k of ["mainEntity", "itemListElement", "hasVariant", "subjectOf"]) if (o[k] && typeof o[k] === "object") flattenLd(o[k], out);
  }
}
const typesOf = (o: Record<string, unknown>) => ([] as unknown[]).concat(o["@type"] as unknown).map(String);

const APPS: [RegExp, string][] = [
  [/klaviyo/, "Klaviyo"], [/judge\.me/, "Judge.me"], [/gokwik/, "GoKwik"], [/shopflo/, "Shopflo"], [/razorpay/, "Razorpay"],
  [/googletagmanager/, "Google Tag Manager"], [/google-analytics|gtag\/js/, "Google Analytics"], [/connect\.facebook\.net/, "Meta Pixel"],
  [/hotjar/, "Hotjar"], [/clarity\.ms/, "Microsoft Clarity"], [/intercom/, "Intercom"], [/tidio/, "Tidio"], [/wati\.io/, "WATI"],
  [/interakt/, "Interakt"], [/yotpo/, "Yotpo"], [/loox/, "Loox"], [/okendo/, "Okendo"], [/stamped\.io/, "Stamped"], [/gorgias/, "Gorgias"],
  [/zdassets|zendesk/, "Zendesk"], [/hs-scripts|hubspot/, "HubSpot"], [/analytics\.tiktok/, "TikTok Pixel"], [/sc-static\.net/, "Snap Pixel"],
  [/pinimg|pintrk/, "Pinterest"], [/criteo/, "Criteo"], [/doubleclick|googleadservices/, "Google Ads"], [/bat\.bing/, "Microsoft Ads"],
  [/webengage/, "WebEngage"], [/moengage/, "MoEngage"], [/clevertap/, "CleverTap"], [/limechat/, "LimeChat"], [/bik\.ai/, "BiK"],
  [/recaptcha/, "reCAPTCHA"], [/cloudflareinsights/, "Cloudflare Analytics"], [/youtube/, "YouTube"], [/vimeo/, "Vimeo"],
  [/smartrr|recharge/, "Recharge"], [/privy/, "Privy"], [/omnisend/, "Omnisend"], [/trustpilot/, "Trustpilot"], [/elfsight/, "Elfsight"],
];

function analyzeHtml(html: string, pageUrl: URL) {
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [html.slice(0, 200000)])[0];
  const title = decode(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim());
  const metas = (head.match(/<meta\b[^>]*>/gi) || []).map(attrs);
  const meta = (k: string) => (metas.find((m) => (m.name || m.property || "").toLowerCase() === k) || {}).content || "";
  const links = (head.match(/<link\b[^>]*>/gi) || []).map(attrs);
  const canonical = (links.find((l) => (l.rel || "").toLowerCase().split(/\s+/).includes("canonical")) || {}).href || "";
  const hreflang = links.filter((l) => l.hreflang).length;
  const lang = (attrs((html.match(/<html\b[^>]*>/i) || ["<html>"])[0]).lang) || "";
  const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim());
  const imgs = (html.match(/<img\b[^>]*>/gi) || []).map(attrs);
  const imgsNoAlt = imgs.filter((i) => !("alt" in i)).length;
  const imgsEmptyAlt = imgs.filter((i) => "alt" in i && !i.alt.trim()).length;

  // JSON-LD
  const nodes: Record<string, unknown>[] = [];
  let ldBlocks = 0, ldErrors = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    ldBlocks++;
    try { flattenLd(JSON.parse(m[1].trim()), nodes); } catch { ldErrors++; }
  }
  const HELPER = new Set(["ListItem", "Offer", "AggregateOffer", "AggregateRating", "Rating", "Review", "PropertyValue", "ImageObject", "Question", "Answer", "Person", "Brand", "UnitPriceSpecification", "PriceSpecification", "QuantitativeValue", "PostalAddress", "ContactPoint", "OfferShippingDetails", "MerchantReturnPolicy", "SearchAction", "EntryPoint", "DefinedRegion", "ShippingDeliveryTime"]);
  const allTypes = [...new Set(nodes.flatMap(typesOf))];
  const types = allTypes.filter((t) => !HELPER.has(t));
  const find = (t: string) => nodes.find((n) => typesOf(n).includes(t));
  const prodNode = find("Product") || find("ProductGroup");
  let product = null as null | Record<string, unknown>;
  if (prodNode) {
    const offers = ([] as unknown[]).concat((prodNode.offers as unknown) || []).flatMap((o) => (o && typeof o === "object" && (o as Record<string, unknown>).offers) ? ([] as unknown[]).concat((o as Record<string, unknown>).offers) : [o]) as Record<string, unknown>[];
    const specPrice = (o: Record<string, unknown>) => {
      const ps = ([] as unknown[]).concat((o && o.priceSpecification) || []) as Record<string, unknown>[];
      const hit = ps.find((x) => x && x.price != null);
      return hit ? { price: hit.price, currency: hit.priceCurrency } : null;
    };
    const off = offers.find((o) => o && (o.price || o.lowPrice || specPrice(o))) || offers[0] || {};
    const sp = specPrice(off);
    const ar = (prodNode.aggregateRating || {}) as Record<string, unknown>;
    product = {
      name: String(prodNode.name || ""),
      price: String(off.price ?? off.lowPrice ?? (sp ? sp.price : "") ?? ""),
      currency: String(off.priceCurrency || (sp ? sp.currency : "") || ""),
      availability: off ? String(off.availability || "").replace(/^https?:\/\/schema\.org\//, "") : "",
      rating: ar.ratingValue != null ? String(ar.ratingValue) : "",
      reviews: ar.reviewCount != null ? String(ar.reviewCount) : ar.ratingCount != null ? String(ar.ratingCount) : "",
      brand: typeof prodNode.brand === "object" ? String((prodNode.brand as Record<string, unknown>)?.name || "") : String(prodNode.brand || ""),
    };
  }
  const orgNode = find("Organization") || find("Corporation") || find("OnlineStore") || find("Brand");
  const org = orgNode ? { name: String(orgNode.name || ""), sameAs: ([] as unknown[]).concat(orgNode.sameAs || []).length, logo: !!orgNode.logo } : null;
  const microProduct = /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html);

  const text = visibleText(html);
  const words = text ? text.split(" ").length : 0;
  const priceM = text.match(/(₹|Rs\.?|INR|US\$|\$|€|£|AED|SGD|AU\$|CA\$)\s?\d[\d,]*(?:\.\d{1,2})?/i);
  const faqText = /\b(faqs?|frequently asked)\b/i.test(text);

  // scripts
  const site = pageUrl.hostname.replace(/^www\./, "");
  const srcs = (html.match(/<script\b[^>]*\bsrc\s*=\s*[^>]*>/gi) || []).map((t) => attrs(t).src || "").filter(Boolean);
  const inlineBlob = html.slice(0, MAX_BYTES);
  const third = new Set<string>();
  let thirdCount = 0;
  for (const s of srcs) {
    let h = "";
    try { h = new URL(s, pageUrl).hostname.replace(/^www\./, ""); } catch { continue; }
    if (h === site || h.endsWith("." + site) || /cdn\.shopify\.com|shopifycdn|shopifycloud/.test(h)) continue;
    thirdCount++;
  }
  for (const [re, name] of APPS) if (re.test(inlineBlob)) third.add(name);

  const platform = /cdn\.shopify\.com|Shopify\.theme|shopifycloud/i.test(html) ? "Shopify"
    : /wp-content|woocommerce/i.test(html) ? "WordPress / WooCommerce"
    : /Magento|mage\/cookies/i.test(html) ? "Magento"
    : /__NEXT_DATA__|\/_next\//.test(html) ? "Next.js"
    : /wix\.com|wixstatic/i.test(html) ? "Wix" : "";

  const ogType = meta("og:type");
  const isProduct = /\/products?\//i.test(pageUrl.pathname) || !!prodNode || /product/i.test(ogType);

  return {
    title, desc: meta("description"), canonical, hreflang, lang,
    robotsMeta: meta("robots"), viewport: !!meta("viewport"),
    og: { title: meta("og:title"), image: meta("og:image"), type: ogType },
    h1Count: h1s.length, h1: h1s[0] || "",
    imgs: imgs.length, imgsNoAlt, imgsEmptyAlt,
    jsonld: { blocks: ldBlocks, errors: ldErrors, types, product, org, breadcrumb: types.includes("BreadcrumbList"), faqPage: types.includes("FAQPage"), website: types.includes("WebSite") },
    microProduct, words, price: priceM ? priceM[0] : "", faqText,
    scripts: { total: srcs.length, thirdParty: thirdCount, apps: [...third] },
    platform, isProduct,
    agentText: text.slice(0, 700),
  };
}

// ---------- checks ----------
type Check = { id: string; status: "pass" | "warn" | "fail"; title: string; why: string; detail?: string };
const avg = (cs: Check[]) => cs.length ? Math.round((cs.reduce((s, c) => s + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0) / cs.length) * 100) : null;

async function scan(u: URL) {
  const origin = u.origin;
  const [page, robotsR, llmsR] = await Promise.all([
    get(u.toString(), 20000),
    get(origin + "/robots.txt", 8000),
    get(origin + "/llms.txt", 8000),
  ]);

  const finalUrl = (() => { try { return new URL(page.url); } catch { return u; } })();
  const h = analyzeHtml(page.text, finalUrl);
  const xRobots = page.headers?.get("x-robots-tag") || "";
  const noindex = /noindex/i.test(h.robotsMeta) || /noindex/i.test(xRobots);

  const robotsTxt = robotsR.ok && !/^\s*</.test(robotsR.text) ? robotsR.text : "";
  const parsed = parseRobots(robotsTxt);
  const path = finalUrl.pathname + finalUrl.search;
  const bots = BOTS.map((b) => {
    const { rules, matched } = rulesFor(parsed.groups, b.ua);
    const home = allowed(rules, "/");
    const here = allowed(rules, path || "/");
    return { ua: b.ua, who: b.who, allowed: home.ok && here.ok, rule: (!home.ok ? home.rule : !here.ok ? here.rule : ""), group: matched };
  });
  const bot = (ua: string) => bots.find((b) => b.ua === ua)!;

  // sitemap
  const smUrl = parsed.sitemaps[0] || origin + "/sitemap.xml";
  let sitemap = { found: false, url: smUrl, urls: 0, index: false };
  try {
    if (okHost(new URL(smUrl).hostname)) {
      const sm = await get(smUrl, 8000);
      if (sm.ok && /<(urlset|sitemapindex)\b/i.test(sm.text)) {
        sitemap = { found: true, url: smUrl, urls: (sm.text.match(/<loc>/gi) || []).length, index: /<sitemapindex\b/i.test(sm.text) };
      }
    }
  } catch { /* ignore */ }

  const llmsOk = llmsR.ok && llmsR.text.trim().length > 20 && !/^\s*<(!doctype|html)/i.test(llmsR.text);

  // Page didn't load (404, firewall, bot protection): report what we can, flag the rest.
  if (!page.status || page.status >= 400) {
    const blocked = [401, 403, 429, 503].includes(page.status) || !page.status;
    const S0: Check[] = [
      blocked
        ? { id: "status", status: "fail", title: "Your firewall turned our check away", why: `Status ${page.status || "none"}. Bot protection this strict can also turn away Google and AI crawlers.` }
        : { id: "status", status: "fail", title: `This page returns ${page.status}`, why: "Google drops pages that don't load. Check the URL." },
    ];
    const gb0 = bots.find((b) => b.ua === "Googlebot")!;
    S0.push(gb0.allowed ? { id: "googlebot", status: "pass", title: "Googlebot allowed in robots.txt", why: "Rules don't block Google." } : { id: "googlebot", status: "fail", title: "Googlebot blocked", why: gb0.rule });
    S0.push(sitemap.found ? { id: "sitemap", status: "pass", title: "Sitemap found", why: `${sitemap.urls} ${sitemap.index ? "sitemaps listed" : "URLs"}.` } : { id: "sitemap", status: "warn", title: "No sitemap found", why: "Google discovers new products slower." });
    const A0: Check[] = [];
    for (const [ua, lvl, label] of [["OAI-SearchBot", "fail", "ChatGPT search"], ["PerplexityBot", "fail", "Perplexity"], ["GPTBot", "warn", "OpenAI's crawler"], ["ClaudeBot", "warn", "Claude"], ["Google-Extended", "warn", "Gemini"]] as const) {
      const b = bots.find((x) => x.ua === ua)!;
      A0.push(b.allowed ? { id: ua, status: "pass", title: `${label} allowed in robots.txt`, why: `${ua} isn't blocked by your rules.` } : { id: ua, status: lvl, title: `${label} is blocked`, why: "Blocked in robots.txt.", detail: b.rule });
    }
    A0.push(llmsOk ? { id: "llms", status: "pass", title: "llms.txt found", why: "AI tools get a clean summary of your store." } : { id: "llms", status: "warn", title: "No llms.txt", why: "A short AI-readable summary of your store. Quick win." });
    if (blocked) A0.push({ id: "firewall", status: "fail", title: "Automated visitors get turned away", why: "AI assistants fetch pages much like we do, so they may be blocked too." });
    return {
      url: u.toString(), finalUrl: finalUrl.toString(), status: page.status, htmlMs: page.ms, bytes: page.text.length,
      limited: true, blocked, platform: "", isProduct: /\/products?\//i.test(finalUrl.pathname), html: null, noindex: false,
      robots: { found: !!robotsTxt, bots, sitemaps: parsed.sitemaps.slice(0, 5) },
      sitemap, llms: { found: llmsOk, url: origin + "/llms.txt" },
      search: { score: avg(S0), checks: S0 }, ai: { score: avg(A0), checks: A0 }, scannedAt: new Date().toISOString(),
    };
  }

  // ---- Search checks
  const S: Check[] = [];
  S.push(page.status >= 400 || !page.status
    ? { id: "status", status: "fail", title: "Page doesn't load for Google", why: `It answered with status ${page.status || "none"}.` }
    : noindex ? { id: "status", status: "fail", title: "Page is set to noindex", why: "Google is told not to show this page in results." }
    : { id: "status", status: "pass", title: "Google can index this page", why: "It loads and isn't blocked from search." });
  const tl = h.title.length;
  S.push(!tl ? { id: "title", status: "fail", title: "No page title", why: "Google has to invent one for your result." }
    : tl > 65 ? { id: "title", status: "warn", title: "Title gets cut off in Google", why: `${tl} characters. Around 60 fit in a result.`, detail: h.title }
    : tl < 15 ? { id: "title", status: "warn", title: "Title is very short", why: `${tl} characters. Add the product and brand.`, detail: h.title }
    : { id: "title", status: "pass", title: "Page title fits in Google", why: `${tl} characters.`, detail: h.title });
  const dl = h.desc.length;
  S.push(!dl ? { id: "desc", status: "fail", title: "No meta description", why: "Google picks a random line from your page instead." }
    : dl > 165 ? { id: "desc", status: "warn", title: "Description gets cut off", why: `${dl} characters. About 155 show.`, detail: h.desc }
    : dl < 50 ? { id: "desc", status: "warn", title: "Description is too short", why: `${dl} characters. Say what it is and why buy.`, detail: h.desc }
    : { id: "desc", status: "pass", title: "Meta description set", why: `${dl} characters.`, detail: h.desc });
  S.push(h.canonical ? { id: "canonical", status: "pass", title: "Canonical URL set", why: "Duplicate URLs point Google to one page." }
    : { id: "canonical", status: "warn", title: "No canonical URL", why: "Variant and filter URLs can compete with each other." });
  S.push(h.h1Count === 1 ? { id: "h1", status: "pass", title: "One clear H1 heading", why: h.h1.slice(0, 80) }
    : h.h1Count === 0 ? { id: "h1", status: "warn", title: "No H1 heading", why: "Search engines use it to understand the page." }
    : { id: "h1", status: "warn", title: `${h.h1Count} H1 headings`, why: "One main heading per page reads clearer." });
  if (h.imgs) {
    const cov = Math.round(((h.imgs - h.imgsNoAlt) / h.imgs) * 100);
    S.push(cov >= 90 ? { id: "alt", status: "pass", title: "Images have alt text", why: `${cov}% of ${h.imgs} images.` }
      : { id: "alt", status: cov >= 70 ? "warn" : "fail", title: "Images missing alt text", why: `${h.imgsNoAlt} of ${h.imgs} images have none, so image search can't read them.` });
  }
  if (h.isProduct) {
    const p = h.jsonld.product;
    S.push(p ? { id: "schema", status: "pass", title: "Product schema found", why: "Google can read the product's details." }
      : { id: "schema", status: "fail", title: "No Product schema", why: h.microProduct ? "Only old-style microdata. Add JSON-LD." : "No price, stock or stars in your Google result." });
    if (p) {
      S.push(p.price ? { id: "offer", status: "pass", title: "Price and stock in schema", why: `${p.currency} ${p.price}${p.availability ? " · " + p.availability : ""}`.trim() }
        : { id: "offer", status: "fail", title: "No price in schema", why: "Google can't show your price in results." });
      S.push(p.rating ? { id: "rating", status: "pass", title: "Ratings in schema", why: `${p.rating} from ${p.reviews || "?"} reviews. Stars can show in Google.` }
        : { id: "rating", status: "warn", title: "No ratings in schema", why: "No review stars next to your result." });
    }
  } else {
    S.push(h.jsonld.org || h.jsonld.website ? { id: "schema", status: "pass", title: "Brand schema found", why: `Types: ${h.jsonld.types.slice(0, 5).join(", ")}` }
      : h.jsonld.blocks ? { id: "schema", status: "warn", title: "No Organization schema", why: `Found: ${h.jsonld.types.slice(0, 5).join(", ") || "unreadable JSON-LD"}` }
      : { id: "schema", status: "fail", title: "No structured data", why: "Search engines get no labelled facts about your brand." });
  }
  S.push(sitemap.found ? { id: "sitemap", status: "pass", title: "Sitemap found", why: `${sitemap.urls} ${sitemap.index ? "sitemaps listed" : "URLs"}.` }
    : { id: "sitemap", status: "warn", title: "No sitemap found", why: "Google discovers new products slower." });
  const gb = bot("Googlebot");
  S.push(gb.allowed ? { id: "googlebot", status: "pass", title: "Googlebot allowed", why: robotsTxt ? "robots.txt lets Google crawl this page." : "No robots.txt rules block it." }
    : { id: "googlebot", status: "fail", title: "Googlebot blocked", why: gb.rule });
  S.push(h.lang ? { id: "lang", status: "pass", title: "Page language set", why: h.lang } : { id: "lang", status: "warn", title: "No page language", why: "Add lang to the html tag." });
  S.push(h.og.title && h.og.image ? { id: "og", status: "pass", title: "Share preview set", why: "Links look right on WhatsApp and social." }
    : { id: "og", status: "warn", title: "Share preview incomplete", why: "Missing og:title or og:image for link previews." });
  S.push(finalUrl.protocol === "https:" ? { id: "https", status: "pass", title: "Served over HTTPS", why: "Secure." } : { id: "https", status: "fail", title: "Not on HTTPS", why: "Browsers mark the page as not secure." });

  // ---- AI checks
  const A: Check[] = [];
  const botCheck = (ua: string, failLevel: "fail" | "warn", label: string, okWhy: string, badWhy: string) => {
    const b = bot(ua);
    A.push(b.allowed ? { id: ua, status: "pass", title: `${label} can read your site`, why: okWhy }
      : { id: ua, status: failLevel, title: `${label} is blocked`, why: badWhy, detail: b.rule });
  };
  botCheck("OAI-SearchBot", "fail", "ChatGPT search", "OAI-SearchBot is allowed.", "You won't appear in ChatGPT search answers.");
  botCheck("PerplexityBot", "fail", "Perplexity", "PerplexityBot is allowed.", "Perplexity can't cite your pages.");
  botCheck("GPTBot", "warn", "OpenAI's crawler", "GPTBot is allowed.", "Blocks OpenAI training. Some brands choose this on purpose.");
  botCheck("ClaudeBot", "warn", "Claude", "ClaudeBot is allowed.", "Claude can't read your pages.");
  botCheck("Google-Extended", "warn", "Gemini", "Google-Extended is allowed.", "Opts you out of Gemini.");
  A.push(llmsOk ? { id: "llms", status: "pass", title: "llms.txt found", why: "AI tools get a clean summary of your store." }
    : { id: "llms", status: "warn", title: "No llms.txt", why: "A short AI-readable summary of your store. Quick win." });
  A.push(h.words >= 150 ? { id: "rawtext", status: "pass", title: "Content readable without JavaScript", why: `${h.words} words in the raw HTML.` }
    : { id: "rawtext", status: h.words >= 50 ? "warn" : "fail", title: "Content needs JavaScript", why: `Only ${h.words} words in the raw HTML. Most AI bots don't run JS.` });
  if (h.isProduct) {
    const sPrice = h.jsonld.product && h.jsonld.product.price ? `${h.jsonld.product.currency} ${h.jsonld.product.price}`.trim() : "";
    const hasPrice = !!sPrice || !!h.price;
    A.push(hasPrice ? { id: "rawprice", status: "pass", title: "Price readable by AI", why: sPrice ? `Price is in your schema: ${sPrice}.` : `A price (${h.price}) appears in the raw HTML.` }
      : { id: "rawprice", status: "fail", title: "Price hidden from AI", why: "No price in the raw HTML or schema." });
  }
  A.push(h.jsonld.blocks && !h.jsonld.errors ? { id: "jsonld", status: "pass", title: "Structured data AI can parse", why: h.jsonld.types.slice(0, 5).join(", ") }
    : h.jsonld.blocks ? { id: "jsonld", status: "warn", title: "Structured data has errors", why: `${h.jsonld.errors} of ${h.jsonld.blocks} JSON-LD blocks don't parse.` }
    : { id: "jsonld", status: "fail", title: "No structured data", why: "AI has to guess your product facts." });
  A.push(h.jsonld.faqPage ? { id: "faq", status: "pass", title: "FAQs marked up", why: "FAQPage schema found. Easy for AI to quote." }
    : h.faqText ? { id: "faq", status: "warn", title: "FAQs not marked up", why: "You have FAQs, but no FAQPage schema." }
    : { id: "faq", status: "warn", title: "No FAQs on the page", why: "Nothing for AI to quote when shoppers ask questions." });
  A.push(h.jsonld.org && h.jsonld.org.name ? { id: "org", status: "pass", title: "Brand identity is clear", why: `${h.jsonld.org.name}${h.jsonld.org.sameAs ? ` · ${h.jsonld.org.sameAs} profiles linked` : ""}` }
    : { id: "org", status: "warn", title: "Brand identity unclear", why: "No Organization schema telling AI who you are." });

  return {
    url: u.toString(), finalUrl: finalUrl.toString(), status: page.status, htmlMs: page.ms, bytes: page.text.length,
    platform: h.platform, isProduct: h.isProduct,
    html: h, noindex,
    robots: { found: !!robotsTxt, bots, sitemaps: parsed.sitemaps.slice(0, 5) },
    sitemap, llms: { found: llmsOk, url: origin + "/llms.txt" },
    search: { score: avg(S), checks: S },
    ai: { score: avg(A), checks: A },
    scannedAt: new Date().toISOString(),
  };
}

// ---------- PSI proxy ----------
const KEEP = new Set([
  "first-contentful-paint", "largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "speed-index", "interactive",
  "server-response-time", "screenshot-thumbnails", "final-screenshot", "largest-contentful-paint-element", "third-party-summary",
  "total-byte-weight", "network-requests",
]);
function trimPsi(d: Record<string, any>) {
  const lr = d.lighthouseResult || {};
  const audits: Record<string, any> = {};
  for (const [k, a] of Object.entries<any>(lr.audits || {})) {
    const hasSavings = a && ((a.metricSavings && Object.values(a.metricSavings).some((v: any) => v > 0)) || (a.details && a.details.overallSavingsMs > 0));
    if (KEEP.has(k)) {
      const copy = { ...a };
      if (k === "network-requests") copy.details = { items: (a.details?.items || []).length ? new Array((a.details.items || []).length).fill(0) : [] };
      audits[k] = copy;
    } else if (hasSavings && a.score !== null && a.score < 0.9) {
      audits[k] = { id: a.id, title: a.title, score: a.score, displayValue: a.displayValue, metricSavings: a.metricSavings, details: a.details ? { type: a.details.type, overallSavingsMs: a.details.overallSavingsMs, overallSavingsBytes: a.details.overallSavingsBytes } : undefined };
    }
  }
  const cats: Record<string, any> = {};
  for (const [k, c] of Object.entries<any>(lr.categories || {})) cats[k] = { score: c.score, title: c.title };
  return { loadingExperience: d.loadingExperience, originLoadingExperience: d.originLoadingExperience, lighthouseResult: { lighthouseVersion: lr.lighthouseVersion, finalUrl: lr.finalUrl, categories: cats, audits } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const route = url.pathname.replace(/^.*\/trooperformance-audit/, "") || "/";
  try {
    if (route.startsWith("/psi")) {
      const key = Deno.env.get("PSI_API_KEY");
      if (!key) return json({ error: "no_psi_key" }, 501);
      const target = safeUrl(url.searchParams.get("url") || "");
      if (!target) return json({ error: "bad_url" }, 400);
      const strategy = url.searchParams.get("strategy") === "desktop" ? "desktop" : "mobile";
      const p = new URLSearchParams({ url: target.toString(), strategy, key });
      ["performance", "seo", "accessibility", "best-practices"].forEach((c) => p.append("category", c));
      const r = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + p, { signal: AbortSignal.timeout(110000) });
      const d = await r.json();
      if (!r.ok || !d.lighthouseResult) return json({ error: "psi_failed", detail: d?.error?.message || r.status }, 502);
      return json(trimPsi(d));
    }
    if (route.startsWith("/scan")) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : { url: url.searchParams.get("url") };
      const target = safeUrl(body.url || "");
      if (!target) return json({ error: "bad_url" }, 400);
      const out = await scan(target);
      return json(out, (out as any).error ? 502 : 200);
    }
    return json({ ok: true, service: "trooperformance-audit", routes: ["GET /psi?url=&strategy=", "POST /scan {url}"], psiKey: !!Deno.env.get("PSI_API_KEY") });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error)?.message || e) }, 500);
  }
});
