// TrooPerformance report helpers (Supabase Edge Function, Deno). Called with the public anon key, like trooperformance-audit.
// POST /competitors {url, title, desc, h1, platform}  -> up to 3 likely competitor domains (one small Groq call, each domain DNS-checked)
// POST /email {to, name, data, replaceId?}            -> schedules the branded report email via Resend, REPORT_DELAY_MIN after unlock.
//                                                        With replaceId (e.g. after a competitor test) the scheduled email is cancelled and re-sent with the new data.
// GET  /                                              -> health: which secrets are set
// The email HTML is built HERE from numbers and short strings (report-doc.js, same file as the site's), never taken from the browser.
import "./report-doc.js";
// deno-lint-ignore no-explicit-any
const TP = (globalThis as any).TPReportDoc;

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, apikey, x-client-info" };
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const RESEND = Deno.env.get("RESEND_API_KEY") || "";
const GROQ = Deno.env.get("GROQ_API_KEY") || "";
const FROM = Deno.env.get("REPORT_FROM") || "TrooPerformance by Troopod <reports@troopodhq.com>";
const REPLY_TO = Deno.env.get("REPORT_REPLY_TO") || "";
const DELAY_MIN = Math.max(1, Math.min(240, Number(Deno.env.get("REPORT_DELAY_MIN") || 15)));
const BCC = (Deno.env.get("REPORT_BCC") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ASSETS = "https://purrieie.github.io/trooperformance/";

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
    vitals: arr(d.vitals, 6).map((v: any) => ({ name: str(v.name, 40), abbr: str(v.abbr, 12), value: str(v.value, 16), good: str(v.good, 20), kind: KINDS.has(v.kind) ? v.kind : "" })),
    fixes: arr(d.fixes, 8).map((x: any) => ({ tag: TAGS.has(x.tag) ? x.tag : "Performance", title: str(x.title, 140), why: str(x.why, 300), imp: str(x.imp, 60), effort: str(x.effort, 30), who: str(x.who, 40) })),
    search: arr(d.search, 30).map((c: any) => ({ status: STAT.has(c.status) ? c.status : "warn", title: str(c.title, 120), why: str(c.why, 260) })),
    ai: arr(d.ai, 30).map((c: any) => ({ status: STAT.has(c.status) ? c.status : "warn", title: str(c.title, 120), why: str(c.why, 260) })),
    bots: arr(d.bots, 10).map((b: unknown) => str(b, 30)).filter(Boolean),
    apps: arr(d.apps, 6).map((a: any) => ({ name: str(a.name, 50), ms: Math.max(0, Math.min(60000, Number(a.ms) || 0)) })),
    comps: arr(d.comps, 4).map((c: any) => ({ site: str(c.site, 80), perf: num(c.perf), si: str(c.si, 12), lcp: str(c.lcp, 12), you: !!c.you })).filter((c: any) => hostOk(c.site)),
    reportUrl: /^https:\/\/purrieie\.github\.io\/trooperformance\//.test(String(d.reportUrl || "")) ? str(d.reportUrl, 400) : "",
    demoUrl: "https://calendly.com/nj-troopod/troopod-demo",
  };
}

async function resend(path: string, body?: unknown) {
  const r = await fetch("https://api.resend.com" + path, { method: "POST", headers: { authorization: "Bearer " + RESEND, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d };
}

async function handleEmail(req: Request) {
  if (!RESEND) return json({ error: "not_configured" }, 503);
  const b = await req.json().catch(() => ({}));
  const to = str(b.to, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return json({ error: "bad_email" }, 400);
  if (personal(to.split("@")[1])) return json({ error: "personal_email" }, 400);
  const data = cleanData(b.data || {});
  if (!data) return json({ error: "bad_data" }, 400);
  if (b.name) data.name = str(b.name, 60).split(" ")[0];
  const replaceId = /^[0-9a-f-]{20,60}$/i.test(String(b.replaceId || "")) ? String(b.replaceId) : "";
  if (limited("ip:" + ipOf(req), 8, 3600_000) || limited("to:" + to, replaceId ? 6 : 3, 86400_000)) return json({ error: "rate_limited" }, 429);
  if (replaceId) {
    const c = await resend("/emails/" + replaceId + "/cancel");
    if (!c.ok) return json({ ok: true, id: replaceId, kept: true, reason: "already_sent_or_unknown" });
  }
  const sendAt = new Date(Date.now() + DELAY_MIN * 60_000).toISOString();
  const html = TP.render(data, { mode: "email", assetBase: ASSETS });
  const payload: Record<string, unknown> = { from: FROM, to: [to], subject: TP.subject(data), html, scheduled_at: sendAt, tags: [{ name: "source", value: "trooperformance" }] };
  if (REPLY_TO) payload.reply_to = REPLY_TO;
  if (BCC.length) payload.bcc = BCC;
  const r = await resend("/emails", payload);
  if (!r.ok) return json({ error: "send_failed", detail: r.status, msg: str(r.d?.message, 200) }, 502);
  return json({ ok: true, id: r.d.id, sendAt });
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
async function groq(model: string, messages: unknown[]) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(20000), headers: { authorization: "Bearer " + GROQ, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_completion_tokens: 900, response_format: { type: "json_object" }, ...(/gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}) }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d?.choices) throw new Error("groq " + r.status);
  return JSON.parse(d.choices[0].message.content || "{}");
}
async function handleCompetitors(req: Request) {
  if (!GROQ) return json({ error: "not_configured" }, 503);
  if (limited("cmp:" + ipOf(req), 12, 3600_000)) return json({ error: "rate_limited" }, 429);
  const b = await req.json().catch(() => ({}));
  const site = str(b.url, 200).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (!hostOk(site)) return json({ error: "bad_url" }, 400);
  const sys = "You name direct online competitors of a D2C (direct-to-consumer) brand. Reply with JSON only: {\"competitors\":[{\"domain\":\"brand.com\",\"name\":\"Brand\"}]}. Rules: 5 brands, most direct first. Same product category and similar price band, selling in the same country as the store. Real brands with their own online store; give the brand's own website domain (no marketplaces like amazon, flipkart, nykaa, myntra, etsy; no blogs or review sites). Never return the store itself.";
  const user = "Store: " + site + "\nTitle: " + str(b.title, 160) + "\nDescription: " + str(b.desc, 300) + "\nMain heading: " + str(b.h1, 160) + "\nPlatform: " + str(b.platform, 30) + "\nCountry hint: " + (/\.in$/.test(site) || /₹|rs\.?\s?\d|inr/i.test(str(b.desc, 300) + str(b.title, 160)) ? "India" : "use the domain and text");
  let out: { competitors?: { domain?: string; name?: string }[] } = {};
  try { out = await groq("openai/gpt-oss-120b", [{ role: "system", content: sys }, { role: "user", content: user }]); }
  catch { try { out = await groq("llama-3.3-70b-versatile", [{ role: "system", content: sys }, { role: "user", content: user }]); } catch { return json({ error: "ai_failed" }, 502); } }
  const BAN = /(^|\.)(amazon|flipkart|nykaa|myntra|ajio|meesho|etsy|ebay|walmart|tatacliq|jiomart|snapdeal|instagram|facebook|youtube|wikipedia)\./i;
  const seen = new Set([site]);
  const cands = (out.competitors || []).map((c) => str(c.domain, 80).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""))
    .filter((d) => hostOk(d) && !BAN.test(d + ".") && !seen.has(d) && (seen.add(d), true)).slice(0, 6);
  const ok = (await Promise.all(cands.map(async (d) => ((await resolves(d)) ? d : null)))).filter(Boolean).slice(0, 3);
  return json({ competitors: ok });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const route = new URL(req.url).pathname.replace(/^.*\/trooperformance-report/, "") || "/";
  try {
    if (req.method === "POST" && route.startsWith("/email")) return await handleEmail(req);
    if (req.method === "POST" && route.startsWith("/competitors")) return await handleCompetitors(req);
    return json({ ok: true, service: "trooperformance-report", resend: !!RESEND, groq: !!GROQ, from: FROM, delayMin: DELAY_MIN });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error)?.message || e).slice(0, 200) }, 500);
  }
});
