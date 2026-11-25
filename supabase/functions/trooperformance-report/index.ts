// TrooPerformance report helpers (Supabase Edge Function, Deno). Called with the public anon key, like trooperformance-audit.
// POST /competitors {url, title, desc, h1, platform}  -> up to 3 likely competitor domains (one small Groq call, each domain DNS-checked)
// POST /email {to, name, data}                        -> queues the report (one pending row per email + store; a competitor test updates it).
//                                                        Sending happens after approval, twice a day, from tools/report-queue/queue.mjs.
// GET  /queue, POST /queue/mark {results}             -> private (x-admin-token): pending list, mark sent/rejected/failed
// POST /admin/set {k:"groq_key", v}                    -> private (x-admin-token): Jaanya saves the Groq key from her Terminal
// GET  /                                              -> health
// Only numbers and short strings are stored (cleanData); the email HTML is built at send time by assets/js/report-doc.js.

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, apikey, x-client-info" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const GROQ_ENV = Deno.env.get("GROQ_API_KEY") || "";

// ---------- tiny in-memory rate limits (reset when the function cold-starts; enough to stop casual abuse) ----------
const hits = new Map<string, number[]>();
function limited(key: string, max: number, windowMs: number) {
  const now = Date.now(), arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now); hits.set(key, arr); return false;
}
const ipOf = (req: Request) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "?";

// ---------- input cleaning ----------
const str = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const num = (v: unknown, lo = 0, hi = 100) => (typeof v === "number" && isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : null);
const hostOk = (h: string) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(h);
const FREE = new Set(["gmail.com","googlemail.com","yahoo.com","yahoo.co.in","yahoo.in","yahoo.co.uk","ymail.com","rocketmail.com","outlook.com","outlook.in","hotmail.com","hotmail.co.in","hotmail.co.uk","live.com","live.in","msn.com","icloud.com","me.com","mac.com","aol.com","rediffmail.com","rediff.com","proton.me","protonmail.com","pm.me","tutanota.com","tuta.io","zoho.com","zohomail.com","zohomail.in","yandex.com","yandex.ru","gmx.com","gmx.net","gmx.de","mail.com","email.com","inbox.com","hey.com","fastmail.com","hushmail.com","mail.ru","web.de","qq.com","163.com","126.com","sina.com","naver.com","duck.com","mailinator.com","guerrillamail.com","guerrillamail.info","sharklasers.com","grr.la","10minutemail.com","10minutemail.net","temp-mail.org","tempmail.com","tempmail.net","tempmailo.com","yopmail.com","yopmail.net","trashmail.com","getnada.com","nada.email","dispostable.com","maildrop.cc","mintemail.com","throwawaymail.com","fakeinbox.com","emailondeck.com","mohmal.com","moakt.com","tempr.email","spamgourmet.com","mailnesia.com","mytemp.email","burnermail.io","inboxkitten.com","mailpoof.com","tmail.ws","tmpmail.org"]);
const personal = (d: string) => FREE.has(d) || [...FREE].some((x) => d.endsWith("." + x));
const KINDS = new Set(["ok", "warn", "bad"]), STAT = new Set(["pass", "warn", "fail"]), TAGS = new Set(["Performance", "Search", "AI answers"]);

// deno-lint-ignore no-explicit-any
function cleanData(d: any) {
  const site = str(d?.site, 120).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!hostOk(site)) return null;
  const arr = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(0, n) : []);
  return {
    site, date: str(d.date, 30), platform: str(d.platform, 30), name: str(d.name, 60),
    scores: { perf: num(d.scores?.perf), desk: num(d.scores?.desk), search: num(d.scores?.search), ai: num(d.scores?.ai), searchN: num(d.scores?.searchN, 0, 99), aiN: num(d.scores?.aiN, 0, 99) },
    uplift: d.uplift ? { target: num(d.uplift.target), conv: Math.max(0, Math.min(99, Number(d.uplift.conv) || 0)).toFixed(1).replace(/\.0$/, ""), rev: Math.max(0, Math.min(99, Number(d.uplift.rev) || 0)).toFixed(1).replace(/\.0$/, "") } : null,
    cwv: typeof d.cwv === "boolean" ? d.cwv : null,
    vitals: arr(d.vitals, 6).map((v: any) => ({ name: str(v.name, 40), abbr: str(v.abbr, 32), value: str(v.value, 16), good: str(v.good, 20), kind: KINDS.has(v.kind) ? v.kind : "" })),
    fixes: arr(d.fixes, 8).map((x: any) => ({ tag: TAGS.has(x.tag) ? x.tag : "Performance", title: str(x.title, 140), why: str(x.why, 300), imp: str(x.imp, 60), effort: str(x.effort, 30), who: str(x.who, 40) })),
    search: arr(d.search, 30).map((c: any) => ({ status: STAT.has(c.status) ? c.status : "warn", title: str(c.title, 120), why: str(c.why, 260) })),
    ai: arr(d.ai, 30).map((c: any) => ({ status: STAT.has(c.status) ? c.status : "warn", title: str(c.title, 120), why: str(c.why, 260) })),
    bots: arr(d.bots, 10).map((b: unknown) => str(b, 30)).filter(Boolean),
    apps: arr(d.apps, 6).map((a: any) => ({ name: str(a.name, 50), ms: Math.max(0, Math.min(60000, Number(a.ms) || 0)) })),
    comps: arr(d.comps, 4).map((c: any) => ({ site: str(c.site, 80), perf: num(c.perf), si: str(c.si, 12), lcp: str(c.lcp, 12), you: !!c.you })).filter((c: any) => hostOk(c.site)),
    reportUrl: /^https:\/\/(purrieie\.github\.io|(www\.)?troopod\.io)\/trooperformance\//.test(String(d.reportUrl || "")) ? str(d.reportUrl, 400) : "",
    demoUrl: "https://calendly.com/nj-troopod/troopod-demo",
    ctx: d.ctx ? { title: str(d.ctx.title, 160), desc: str(d.ctx.desc, 300), h1: str(d.ctx.h1, 160), price: str(d.ctx.price, 40), text: str(d.ctx.text, 900), platform: str(d.ctx.platform, 30) } : null,
    lab: d.lab ? { si: Math.max(0, Math.min(120000, Number(d.lab.si) || 0)) || null, lcp: Math.max(0, Math.min(120000, Number(d.lab.lcp) || 0)) || null } : null,
    compsAuto: false,
  };
}

// Reports are NOT sent from here. They wait in public.trooperformance_report_queue until Jaanya approves the
// 12 PM / 6 PM batch; the approved ones are sent from her Mac with tools/report-queue/queue.mjs.
const SB_URL = Deno.env.get("SUPABASE_URL") || "", SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const QH = { apikey: SB_KEY, authorization: "Bearer " + SB_KEY, "content-type": "application/json" };
const QURL = () => SB_URL + "/rest/v1/trooperformance_report_queue";
async function handleEmail(req: Request) {
  if (!SB_URL || !SB_KEY) return json({ error: "not_configured" }, 503);
  const b = await req.json().catch(() => ({}));
  const to = str(b.to, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: "bad_email" }, 400);
  if (personal(to.split("@")[1])) return json({ error: "personal_email" }, 400);
  const data = cleanData(b.data || {});
  if (!data) return json({ error: "bad_data" }, 400);
  const name = str(b.name, 80);
  if (name) data.name = name.split(" ")[0];
  if (limited("ip:" + ipOf(req), 12, 3600_000) || limited("to:" + to, 8, 86400_000)) return json({ error: "rate_limited" }, 429);
  const last = await fetch(QURL() + "?select=id,status,created_at&email=eq." + encodeURIComponent(to) + "&site=eq." + encodeURIComponent(data.site) + "&order=created_at.desc&limit=1", { headers: QH }).then((r) => r.json()).catch(() => []);
  const row = Array.isArray(last) ? last[0] : null;
  if (row && row.status === "pending") {
    const r = await fetch(QURL() + "?id=eq." + row.id, { method: "PATCH", headers: { ...QH, prefer: "return=minimal" }, body: JSON.stringify({ data, name: name || null, updated_at: new Date().toISOString() }) });
    return r.ok ? json({ ok: true, id: row.id, queued: true, updated: true }) : json({ error: "save_failed" }, 502);
  }
  if (row && Date.now() - Date.parse(row.created_at) < 7 * 86400_000) return json({ ok: true, id: row.id, queued: false, reason: "already_" + row.status });
  const r = await fetch(QURL(), { method: "POST", headers: { ...QH, prefer: "return=representation" }, body: JSON.stringify({ email: to, name: name || null, site: data.site, data, ip: ipOf(req), user_agent: str(req.headers.get("user-agent"), 300) }) });
  const d = await r.json().catch(() => null);
  return r.ok && Array.isArray(d) && d[0] ? json({ ok: true, id: d[0].id, queued: true }) : json({ error: "save_failed" }, 502);
}

// ---------- private queue routes for tools/report-queue/queue.mjs (x-admin-token = the queue_token row) ----------
let TOKEN = "";
async function adminOk(req: Request) {
  const t = req.headers.get("x-admin-token") || "";
  if (t.length < 32 || !SB_URL || !SB_KEY) return false;
  if (!TOKEN) { const d = await fetch(SB_URL + "/rest/v1/trooperformance_admin?select=v&k=eq.queue_token", { headers: QH }).then((r) => r.json()).catch(() => []); TOKEN = (Array.isArray(d) && d[0] && d[0].v) || ""; }
  if (!TOKEN || t.length !== TOKEN.length) return false;
  let diff = 0; for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}
async function handleQueueList() {
  const r = await fetch(QURL() + "?select=id,created_at,updated_at,email,name,site,data&status=eq.pending&order=created_at.asc&limit=200", { headers: QH });
  return json({ rows: await r.json().catch(() => []) });
}
async function handleQueueMark(req: Request) {
  const b = await req.json().catch(() => ({}));
  const list = Array.isArray(b.results) ? b.results.slice(0, 200) : [];
  let n = 0;
  for (const x of list) {
    if (!/^[0-9a-f-]{36}$/i.test(String(x.id)) || !["sent", "rejected", "failed"].includes(x.status)) continue;
    const patch: Record<string, unknown> = { status: x.status, updated_at: new Date().toISOString(), note: str(x.error || x.note, 300) || null };
    if (x.status === "sent") { patch.sent_at = new Date().toISOString(); patch.resend_id = str(x.resend_id, 80) || null; }
    const r = await fetch(QURL() + "?id=eq." + x.id + "&status=eq.pending", { method: "PATCH", headers: { ...QH, prefer: "return=minimal" }, body: JSON.stringify(patch) });
    if (r.ok) n++;
  }
  return json({ ok: true, marked: n });
}

async function resolves(domain: string) {
  try {
    for (const t of ["A", "CNAME"]) {
      const r = await fetch("https://dns.google/resolve?name=" + encodeURIComponent(domain) + "&type=" + t, { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      if (Array.isArray(d.Answer) && d.Answer.length) return true;
    }
  } catch { /* fall through */ }
  return false;
}
let GROQ_DB = "", GROQ_AT = 0;
async function groqKey() {
  if (GROQ_ENV) return GROQ_ENV;
  if (!GROQ_DB || Date.now() - GROQ_AT > 600_000) {
    const d = await fetch(SB_URL + "/rest/v1/trooperformance_admin?select=v&k=eq.groq_key", { headers: QH }).then((r) => r.json()).catch(() => []);
    GROQ_DB = (Array.isArray(d) && d[0] && d[0].v) || ""; GROQ_AT = Date.now();
  }
  return GROQ_DB;
}
async function groq(model: string, messages: unknown[]) {
  const GROQ = await groqKey();
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(20000), headers: { authorization: "Bearer " + GROQ, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_completion_tokens: 900, response_format: { type: "json_object" }, ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}) }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d?.choices) throw new Error("groq " + r.status);
  return JSON.parse(d.choices[0].message.content || "{}");
}
async function handleCompetitors(req: Request) {
  if (!(await groqKey())) return json({ error: "not_configured" }, 503);
  if (limited("cmp:" + ipOf(req), 12, 3600_000)) return json({ error: "rate_limited" }, 429);
  const b = await req.json().catch(() => ({}));
  const site = str(b.url, 200).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!hostOk(site)) return json({ error: "bad_url" }, 400);
  const sys = "You find the CLOSEST direct competitors of a business from its website. It can be any kind of business: a D2C/ecommerce brand, SaaS, fintech, healthtech, edtech, an agency or service firm, a marketplace, a local or B2B business. Step 1: work out what kind of business it is and its exact niche: what it sells, to whom (consumers or businesses), where, and at what price/size (e.g. 'curly and wavy haircare for Indian women, young D2C brand', 'CRO and landing-page agency for D2C brands', 'UPI payments app for small merchants in India'). Step 2: list 6 companies a buyer would genuinely compare it with: same kind of business, same specific offer, same buyers, same country or market, similar size. Prefer peers of similar size over giant incumbents, unless the business itself is a giant. Give each company's own website domain. Leave out marketplaces and app stores (amazon, flipkart, nykaa, myntra, etsy, play store) unless the business itself is a marketplace, and never list blogs, review or listing sites, or the business itself. Most direct rival first. Reply with JSON only: {\"business_type\":\"...\",\"niche\":\"...\",\"competitors\":[{\"domain\":\"company.com\",\"name\":\"Company\",\"why\":\"same offer, same buyer\"}]}";
  const user = "Website: " + site + "\nTitle: " + str(b.title, 160) + "\nDescription: " + str(b.desc, 300) + "\nMain heading: " + str(b.h1, 160) + "\nPrice seen on page: " + (str(b.price, 40) || "unknown") + "\nPlatform: " + str(b.platform, 30) + "\nPage text (start): " + str(b.text, 900) + "\nCountry hint: " + (/\.in$/.test(site) || /₹|rs\.?\s?\d|inr/i.test(str(b.desc, 300) + str(b.title, 160) + str(b.price, 40)) ? "India" : "use the domain and text");
  let out: { business_type?: string; niche?: string; competitors?: { domain?: string; name?: string }[] } = {};
  try { out = await groq("openai/gpt-oss-120b", [{ role: "system", content: sys }, { role: "user", content: user }]); }
  catch { try { out = await groq("llama-3.3-70b-versatile", [{ role: "system", content: sys }, { role: "user", content: user }]); } catch { return json({ error: "ai_failed" }, 502); } }
  const BAN = /(^|\.)(amazon|flipkart|nykaa|myntra|ajio|meesho|etsy|ebay|walmart|tatacliq|jiomart|snapdeal|instagram|facebook|youtube|wikipedia)\./i;
  const seen = new Set([site]), isMarket = /marketplace/i.test(str(out.business_type, 60) + " " + str(out.niche, 160));
  const cands = (out.competitors || []).map((c) => str(c.domain, 80).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter((d) => hostOk(d) && (isMarket || !BAN.test(d + ".")) && !/(^|\.)(instagram|facebook|youtube|wikipedia|linkedin|g2|capterra|clutch|justdial|glassdoor)\./i.test(d + ".") && !seen.has(d) && (seen.add(d), true)).slice(0, 6);
  const ok = (await Promise.all(cands.map(async (d) => ((await resolves(d)) ? d : null)))).filter(Boolean).slice(0, 3);
  return json({ competitors: ok, type: str(out.business_type, 60), niche: str(out.niche, 160) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const route = new URL(req.url).pathname.replace(/^.*\/trooperformance-report/, "") || "/";
  try {
    if (req.method === "POST" && route.startsWith("/email")) return await handleEmail(req);
    if (req.method === "POST" && route.startsWith("/competitors")) return await handleCompetitors(req);
    if (route.startsWith("/queue")) {
      if (!(await adminOk(req))) return json({ error: "forbidden" }, 403);
      if (req.method === "GET") return await handleQueueList();
      if (req.method === "POST" && route.startsWith("/queue/mark")) return await handleQueueMark(req);
    }
    if (route.startsWith("/admin/set")) {
      if (!(await adminOk(req))) return json({ error: "forbidden" }, 403);
      const b = await req.json().catch(() => ({}));
      if (b.k !== "groq_key" || !/^gsk_[A-Za-z0-9]{20,80}$/.test(String(b.v || ""))) return json({ error: "bad_value" }, 400);
      const r = await fetch(SB_URL + "/rest/v1/trooperformance_admin?on_conflict=k", { method: "POST", headers: { ...QH, prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ k: "groq_key", v: b.v }) });
      GROQ_DB = ""; GROQ_AT = 0;
      return r.ok ? json({ ok: true, saved: "groq_key" }) : json({ error: "save_failed" }, 502);
    }
    return json({ ok: true, service: "trooperformance-report", queue: !!(SB_URL && SB_KEY), groq: !!(await groqKey()) });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
