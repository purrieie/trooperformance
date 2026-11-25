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
// Resend key: RESEND_API_KEY env var, else ~/Desktop/Troopod/TrooFestive/Handoff/outreach/.env (never printed).
// Sender: REPORT_FROM (default "TrooPerformance by Troopod <reports@troopodhq.com>"), optional REPORT_REPLY_TO, REPORT_BCC.
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
    const sc = (r.data && r.data.scores) || {}, f = flags(r, rows), c = r.data && r.data.comps && r.data.comps.length > 1 ? " · competitors " + (r.data.comps.length - 1) : "";
    console.log(`${i + 1}. ${r.site}  →  ${r.name || "(no name)"} <${r.email}>  ·  perf ${sc.perf ?? "–"} · search ${sc.search ?? "–"} · AI ${sc.ai ?? "–"}${c}  ·  ${new Date(r.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}`);
    if (f.length) console.log(`   ⚠ ${f.join(" · ")}`);
  });
  process.exit(0);
}

if (cmd === "preview") {
  const out = rest[0] || path.join(os.tmpdir(), "tp-report-preview");
  fs.mkdirSync(out, { recursive: true });
  rows.forEach((r, i) => { fs.writeFileSync(path.join(out, `${i + 1}-${r.site}.html`), TP.render(r.data, { mode: "email", assetBase: ASSETS })); });
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
  if (!key) {
    const envFile = path.join(os.homedir(), "Desktop/Troopod/TrooFestive/Handoff/outreach/.env");
    const m = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf8").match(/^RESEND_API_KEY=\s*"?([^"\n]+)"?/m);
    key = m ? m[1].trim() : "";
  }
  if (!key) { console.error("No Resend key found."); process.exit(1); }
  const from = process.env.REPORT_FROM || "TrooPerformance by Troopod <reports@troopodhq.com>";
  const replyTo = process.env.REPORT_REPLY_TO || "", bcc = (process.env.REPORT_BCC || "").split(",").map((s) => s.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (skip.has(i + 1)) { results.push({ n: i + 1, id: r.id, status: "rejected", note: "rejected in review" }); continue; }
    const body = { from, to: [r.email], subject: TP.subject(r.data), html: TP.render(r.data, { mode: "email", assetBase: ASSETS }), tags: [{ name: "source", value: "trooperformance" }] };
    if (replyTo) body.reply_to = replyTo;
    if (bcc.length) body.bcc = bcc;
    try {
      const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + key, "content-type": "application/json", "idempotency-key": "tp-report-" + r.id }, body: JSON.stringify(body) });
      const d = await res.json().catch(() => ({}));
      results.push(res.ok ? { n: i + 1, id: r.id, status: "sent", resend_id: d.id } : { n: i + 1, id: r.id, status: "failed", error: String(d.message || res.status).slice(0, 200) });
    } catch (e) { results.push({ n: i + 1, id: r.id, status: "failed", error: String(e.message || e).slice(0, 200) }); }
    await new Promise((ok) => setTimeout(ok, 600)); // Resend allows 2 requests a second
  }
  const marked = await mark(results.filter((x) => x.status !== "failed"));
  console.log(JSON.stringify({ sent: results.filter((x) => x.status === "sent").length, rejected: results.filter((x) => x.status === "rejected").length, failed: results.filter((x) => x.status === "failed"), marked, results }));
  process.exit(results.some((x) => x.status === "failed") ? 1 : 0);
}

console.error("unknown command: " + cmd); process.exit(2);
