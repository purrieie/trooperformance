// TrooPerformance lead capture (Supabase Edge Function, Deno).
// POST {name, email, phone, country_code, site, orders, heard_from, competitors[], speed, search, ai, report, utm_*} -> saves a row to public.trooperformance_leads.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
};
const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...CORS, "content-type": "application/json" } });
const str = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n);
const int = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);
// Personal and throwaway inboxes we don't accept: the form asks for a work email.
const FREE = new Set<string>(["gmail.com","googlemail.com","yahoo.com","yahoo.co.in","yahoo.in","yahoo.co.uk","ymail.com","rocketmail.com","outlook.com","outlook.in","hotmail.com","hotmail.co.in","hotmail.co.uk","live.com","live.in","msn.com","icloud.com","me.com","mac.com","aol.com","rediffmail.com","rediff.com","proton.me","protonmail.com","pm.me","tutanota.com","tuta.io","zoho.com","zohomail.com","zohomail.in","yandex.com","yandex.ru","gmx.com","gmx.net","gmx.de","mail.com","email.com","inbox.com","hey.com","fastmail.com","hushmail.com","mail.ru","web.de","qq.com","163.com","126.com","sina.com","naver.com","duck.com","mailinator.com","guerrillamail.com","guerrillamail.info","sharklasers.com","grr.la","10minutemail.com","10minutemail.net","temp-mail.org","tempmail.com","tempmail.net","tempmailo.com","yopmail.com","yopmail.net","trashmail.com","getnada.com","nada.email","dispostable.com","maildrop.cc","mintemail.com","throwawaymail.com","fakeinbox.com","emailondeck.com","mohmal.com","moakt.com","tempr.email","spamgourmet.com","mailnesia.com","mytemp.email","burnermail.io","inboxkitten.com","mailpoof.com","tmail.ws","tmpmail.org"]);
const isPersonal = (domain: string) => FREE.has(domain) || [...FREE].some((d) => domain.endsWith("." + d));
// The email's domain must be able to receive mail (MX record, or an A record as the fallback mail host).
async function canReceive(domain: string): Promise<boolean | null> {
  try {
    for (const type of ["MX", "A"]) {
      const r = await fetch("https://dns.google/resolve?name=" + encodeURIComponent(domain) + "&type=" + type, { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      if (d.Status === 3) return false; // NXDOMAIN: the domain doesn't exist
      if (Array.isArray(d.Answer) && d.Answer.some((a: { type: number }) => a.type === (type === "MX" ? 15 : 1))) return true;
    }
    return false;
  } catch { return null; } // DNS lookup failed: don't block the lead
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: true, service: "trooperformance-lead" });
  try {
    const b = await req.json().catch(() => ({}));
    const email = str(b.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "bad_email" }, 400);
    const domain = email.split("@")[1];
    if (isPersonal(domain)) return json({ error: "personal_email" }, 400);
    if ((await canReceive(domain)) === false) return json({ error: "no_mail_domain" }, 400);
    let site: URL;
    try { site = new URL(/^https?:\/\//i.test(str(b.site, 300)) ? str(b.site, 300) : "https://" + str(b.site, 300)); } catch { return json({ error: "bad_url" }, 400); }
    if (!/^https?:$/.test(site.protocol) || !site.hostname.includes(".")) return json({ error: "bad_url" }, 400);
    const row = {
      name: str(b.name, 120) || null, email, phone: str(b.phone, 40) || null, site: site.toString(),
      country_code: str(b.country_code, 20) || null, orders: str(b.orders, 40) || null, heard_from: str(b.heard_from, 40) || null,
      utm: Object.fromEntries(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "referrer", "landing_url"].map((k) => [k, str(b[k], 500)]).filter(([, v]) => v)),
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
