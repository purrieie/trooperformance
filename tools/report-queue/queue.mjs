#!/usr/bin/env node
// TrooPerformance report queue: review, preview and send the report emails that are waiting for approval.
// Rows are the pending entries of public.trooperformance_report_queue, read through the trooperformance-report
// function with the private token in tools/report-queue/.admin-token (git-ignored). The numbering is oldest first.
//
//   node tools/report-queue/queue.mjs review                 numbered list + junk flags
//   node tools/report-queue/queue.mjs preview [outDir]       writes each email as HTML to look at
//   node tools/report-queue/queue.mjs send [--skip 2,5]      sends all except the skipped numbers (those are marked rejected)
//   node tools/report-queue/queue.mjs reject 2,5             marks those as rejected without sending anything
// Sent ones are marked sent; a failed send stays pending, so the next batch retries it.
//
// Resend key: RESEND_API_KEY env var, else tools/report-queue/.resend-key (git-ignored), else the outreach .env (never printed).
// Sender: REPORT_FROM (default "Jaanya from Troopod <jaanya@troopod.io>", needs the troopod.io Resend key), REPORT_REPLY_TO, REPORT_BCC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
createRequire(import.meta.url)(path.join(here, "../../assets/js/report-doc.js"));
const TP = globalThis.TPReportDoc;
const ASSETS = "https://purrieie.github.io/trooperformance/";

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) { console.error("usage: queue.mjs review | preview [dir] | send [--skip 2,5] | reject 2,5"); process.exit(2); }
const cfg = fs.readFileSync(path.join(here, "../../assets/js/config.js"), "utf8");
const API = (cfg.match(/reportApi:\s*"([^"]+)"/) || [])[1], ANON = (cfg.match(/anonKey:\s*"([^"]+)"/) || [])[1];
const TOKEN = fs.readFileSync(path.join(here, ".admin-token"), "utf8").trim();
const H = { authorization: "Bearer " + ANON, apikey: ANON, "x-admin-token": TOKEN, "content-type": "application/json" };
const lr = await fetch(API + "/queue", { headers: H });
if (!lr.ok) { console.error("Couldn't read the queue: " + lr.status); process.exit(1); }
const rows = ((await lr.json()).rows || []).map((r) => ({ ...r, data: typeof r.data === "string" ? JSON.parse(r.data) : r.data }));
async function mark(results) {
  const r = await fetch(API + "/queue/mark", { method: "POST", headers: H, body: JSON.stringify({ results }) });
  return r.ok ? (await r.json()).marked : 0;
}
const PSI_KEY = (cfg.match(/psiKey:\s*"([^"]+)"/) || [])[1] || "";
const sec = (ms) => (ms == null ? "–" : (ms / 1000).toFixed(1) + " s");
// Every email gets a competitor section. If the visitor didn't run the comparison, pick 3 close rivals
// (same finder as the site's Auto-detect button) and run the same Google phone test on them now.
async function psi(site) {
  const u = new URLSearchParams({ url: "https://" + site, strategy: "mobile", category: "performance" });
  if (PSI_KEY) u.set("key", PSI_KEY);
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 110000);
  try {
    const d = await fetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + u, { signal: ctl.signal }).then((r) => r.json());
    const lr = d.lighthouseResult || {}, a = lr.audits || {}, sc = lr.categories && lr.categories.performance && lr.categories.performance.score;
    if (typeof sc !== "number") return null;
    return { perf: Math.round(sc * 100), si: a["speed-index"] && a["speed-index"].numericValue, lcp: a["largest-contentful-paint"] && a["largest-contentful-paint"].numericValue };
  } catch { return null; } finally { clearTimeout(t); }
}
async function ensureComps(r) {
  const d = r.data || {};
  if (Array.isArray(d.comps) && d.comps.length > 1) return "tested by visitor";
  const ctx = d.ctx || {};
  const found = await fetch(API + "/competitors", { method: "POST", headers: H, body: JSON.stringify({ url: d.site, ...ctx }) }).then((x) => x.json()).catch(() => ({}));
  const list = (found.competitors || []).slice(0, 3);
  if (!list.length) return "no rivals found";
  const res = await Promise.all(list.map(async (site) => ({ site, p: await psi(site) })));
  const vit = (name) => ((d.vitals || []).find((v) => v.name === name) || {}).value || "–";
  const you = { site: d.site, perf: d.scores && d.scores.perf, si: d.lab && d.lab.si ? sec(d.lab.si) : vit("Page fills in"), lcp: d.lab && d.lab.lcp ? sec(d.lab.lcp) : vit("Main content shows"), you: true };
  const rows = [you].concat(res.filter((x) => x.p).map((x) => ({ site: x.site, perf: x.p.perf, si: sec(x.p.si), lcp: sec(x.p.lcp), you: false })));
  if (rows.length < 2) return "rivals didn't load";
  rows.sort((a, b) => (b.perf ?? -1) - (a.perf ?? -1));
  d.comps = rows; d.compsAuto = true;
  return "auto-picked: " + rows.filter((x) => !x.you).map((x) => x.site).join(", ");
}
const nums = (s) => new Set(String(s || "").split(",").map((x) => parseInt(x, 10)).filter(Boolean));

// ---------- junk flags ----------
const INTERNAL = /(^|\.)(troopod\.(io|net|org|com)|troopodhq\.com|pushstart\.in)$/i;
const TESTY = /\b(test|testing|asdf|qwerty|abc|xyz|demo|sample|dummy|fake|foo|bar|na|none|null)\b/i;
function flags(r, all) {
  const f = [], dom = (r.email.split("@")[1] || "").toLowerCase(), d = r.data || {}, sc = d.scores || {};
  if (INTERNAL.test(dom)) f.push("internal email");
  if (TESTY.test(r.name || "") || TESTY.test(r.email.split("@")[0])) f.push("test-looking name/email");
  if ((r.name || "").replace(/[^a-z]/gi, "").length < 2) f.push("no real name");
  if (sc.perf == null && sc.search == null) f.push("store never loaded");
  const sameEmail = all.filter((x) => x.email === r.email).length;
  if (sameEmail > 2) f.push(sameEmail + " stores from one email");
  const site = (r.site || "").replace(/^www\./, ""), brandDom = site.split(".").slice(-2).join(".");
  if (dom && !dom.endsWith(brandDom) && !brandDom.endsWith(dom)) f.push("email not on the store's domain");
  return f;
}

if (cmd === "review") {
  if (!rows.length) { console.log("No reports waiting."); process.exit(0); }
  rows.forEach((r, i) => {
    const sc = (r.data && r.data.scores) || {}, f = flags(r, rows), c = r.data && r.data.comps && r.data.comps.length > 1 ? " · competitors " + (r.data.comps.length - 1) + " (they ran it)" : " · competitors auto-added at send";
    console.log(`${i + 1}. ${r.site}  →  ${r.name || "(no name)"} <${r.email}>  ·  perf ${sc.perf ?? "–"} · search ${sc.search ?? "–"} · AI ${sc.ai ?? "–"}${c}  ·  ${new Date(r.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`);
    if (f.length) console.log(`   ⚠ ${f.join(" · ")}`);
  });
  process.exit(0);
}

if (cmd === "preview") {
  const out = rest[0] || path.join(os.tmpdir(), "tp-report-preview");
  fs.mkdirSync(out, { recursive: true });
  for (let i = 0; i < rows.length; i++) { const r = rows[i]; console.error(`${i + 1}. ${r.site}: ${await ensureComps(r)}`); fs.writeFileSync(path.join(out, `${i + 1}-${r.site}.html`), TP.render(r.data, { mode: "email", assetBase: ASSETS })); }
  console.log(out);
  process.exit(0);
}

if (cmd === "reject") {
  const rj = nums(rest[0]);
  const n = await mark(rows.filter((r, i) => rj.has(i + 1)).map((r) => ({ id: r.id, status: "rejected", note: "rejected in review" })));
  console.log(JSON.stringify({ rejected: n }));
  process.exit(0);
}

if (cmd === "send") {
  const skip = nums(rest.indexOf("--skip") >= 0 ? rest[rest.indexOf("--skip") + 1] : "");
  if (!rows.length) { console.log(JSON.stringify({ sent: 0, note: "nothing pending" })); process.exit(0); }
  let key = process.env.RESEND_API_KEY || "";
  const keyFile = path.join(here, ".resend-key"); // the reports' own Resend key (git-ignored), set with: read -s K; printf %s "$K" > tools/report-queue/.resend-key
  if (!key && fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, "utf8").trim();
  if (!key) {
    const envFile = path.join(os.homedir(), "Desktop/Troopod/TrooFestive/Handoff/outreach/.env");
    const m = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(/^RESEND_API_KEY=\s*"?([^"\n]+)"?/m);
    key = m ? m[1].trim() : "";
  }
  if (!key) { console.error("No Resend key found."); process.exit(1); }
  const from = process.env.REPORT_FROM || "Jaanya from Troopod <jaanya@troopod.io>";
  const replyTo = process.env.REPORT_REPLY_TO || "jaanya@troopod.io", bcc = (process.env.REPORT_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (skip.has(i + 1)) { results.push({ n: i + 1, id: r.id, status: "rejected", note: "rejected in review" }); continue; }
    const compNote = await ensureComps(r);
    const body = { from, to: [r.email], subject: TP.subject(r.data), html: TP.render(r.data, { mode: "email", assetBase: ASSETS }), tags: [{ name: "source", value: "trooperformance" }] };
    if (replyTo) body.reply_to = replyTo;
    if (bcc.length) body.bcc = bcc;
    try {
      const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json", "idempotency-key": "tp-report-" + r.id }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      results.push(res.ok ? { n: i + 1, id: r.id, status: "sent", resend_id: d.id, competitors: compNote } : { n: i + 1, id: r.id, status: "failed", error: String(d.message || res.status).slice(0, 200) });
    } catch (e) { results.push({ n: i + 1, id: r.id, status: "failed", error: String(e.message || e).slice(0, 200) }); }
    await new Promise((ok) => setTimeout(ok, 600)); // Resend allows 2 requests a second
  }
  const marked = await mark(results.filter((x) => x.status !== "failed"));
  console.log(JSON.stringify({ sent: results.filter((x) => x.status === "sent").length, rejected: results.filter((x) => x.status === "rejected").length, failed: results.filter((x) => x.status === "failed"), marked, results }));
  process.exit(results.some((x) => x.status === "failed") ? 1 : 0);
}

console.error("unknown command: " + cmd); process.exit(2);
