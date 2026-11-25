// TrooPerformance lead capture (Supabase Edge Function, Deno).
// POST {name, email, phone, site, competitors[], speed, search, ai, report} -> saves a row to public.trooperformance_leads.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const int = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, service: "trooperformance-lead" });
  try {
    const b = await req.json().catch(() => ({}));
    const email = str(b.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "bad_email" }, 400);
    let site: URL;
    try { site = new URL(/^https?:\/\//i.test(str(b.site, 300)) ? str(b.site, 300) : "https://" + str(b.site, 300)); } catch { return json({ error: "bad_url" }, 400); }
    if (!/^https?:$/.test(site.protocol) || !site.hostname.includes(".")) return json({ error: "bad_url" }, 400);
    const row = {
      name: str(b.name, 120) || null, email, phone: str(b.phone, 40) || null, site: site.toString(),
      competitors: (Array.isArray(b.competitors) ? b.competitors : []).slice(0, 3).map((c: unknown) => str(c, 200)).filter(Boolean),
      speed_score: int(b.speed), search_score: int(b.search), ai_score: int(b.ai),
      report_url: str(b.report, 500) || null, user_agent: str(req.headers.get("user-agent"), 300) || null,
    };
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const r = await fetch(Deno.env.get("SUPABASE_URL") + "/rest/v1/trooperformance_leads", {
      method: "POST",
      headers: { "content-type": "application/json", apikey: key, authorization: "Bearer " + key, prefer: "return=minimal" },
      body: JSON.stringify(row),
    });
    if (!r.ok) return json({ error: "save_failed", detail: r.status }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ error: "server_error", detail: String((e as Error)?.message || e) }, 500);
  }
});
