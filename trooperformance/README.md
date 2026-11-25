# TrooPerformance site audit

Free speed, SEO and AEO audit for D2C stores, by Troopod. Static site on GitHub Pages plus one Supabase Edge Function.

Live: https://purrieie.github.io/trooperformance/

## What it does
- **Speed:** Google PageSpeed Insights (mobile + desktop), Chrome real-shopper data (LCP, INP, CLS), a load filmstrip, causes grouped in plain English with Google's time-saved estimates, and an "app tax" table of third-party scripts.
- **Search (SEO):** indexability, title, meta description, canonical, H1, alt text, product schema (price, stock, ratings), sitemap, Googlebot access, language, share preview, HTTPS.
- **AI answers (AEO):** robots.txt access for OAI-SearchBot, GPTBot, ChatGPT-User, PerplexityBot, ClaudeBot, Google-Extended, Applebot-Extended; llms.txt; text and price readable without JavaScript; JSON-LD; FAQs; Organization schema.
- Optional comparison with up to 2 competitors (`audit.html?url=...&vs=a.com,b.com`).

Scores: pass = 1, warning = 0.5, fail = 0, averaged out of 100. Speed = Lighthouse performance score.

## Files
- `index.html` landing page (with its own FAQ schema, robots.txt, sitemap.xml and llms.txt)
- `audit.html` + `assets/js/audit.js` scan animation and report
- `assets/js/config.js` API URL, public Supabase anon key, Calendly, WhatsApp
- `supabase/functions/trooperformance-audit/index.ts` the API (already deployed to the "TrooCRO Audit Agent" Supabase project)

## API
`POST {api}/scan {"url": "..."}` returns the Search + AI checks.
`GET {api}/psi?url=...&strategy=mobile|desktop` proxies PageSpeed Insights. It needs a `PSI_API_KEY` secret on the function; without it the site falls back to calling Google directly, which hits Google's shared free quota and often says "busy".

## Updating
Edit, then:
```
git add . && git commit -m "Update" && git push
```
