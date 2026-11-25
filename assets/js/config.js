/* TrooPerformance site settings. The audit API is a free-plan Supabase Edge Function in the TrooCRO Audit Agent project.
   The anon key below is Supabase's public client key (safe to ship in a website). */
window.TP_CONFIG = {
  api: "https://mrfixorpmhrnkxhqzesn.supabase.co/functions/v1/trooperformance-audit",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1yZml4b3JwbWhybmt4aHF6ZXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NzEwOTEsImV4cCI6MjA5NDQ0NzA5MX0.CUlbgmKtvLKnziZOIkG6rOWp1iJIr0tHaKW05TgTzYA",
  calendly: "https://calendly.com/nj-troopod/troopod-demo",
  /* Google PageSpeed Insights API key (free). Restrict it in Google Cloud: API = PageSpeed Insights only, HTTP referrer = purrieie.github.io/* */
  /* TrooCRO page-view function: returns a store page's HTML so the scan screen can draw it live (drawn with no scripts). */
  /* TrooPerformance report function: auto-detect competitors + the branded report email (Resend). */
  reportApi: "https://mrfixorpmhrnkxhqzesn.supabase.co/functions/v1/trooperformance-report",
  pageView: "https://mrfixorpmhrnkxhqzesn.supabase.co/functions/v1/troocro-page-view",
  psiKey: "AIzaSyC4k7vaxwnNf_CkV_URwKRLls2A3xV1Tfk",
  /* Troopod Apps Script web app (same one as troopod.io/blackfriday). Leads carry source "trooperformance" -> "TrooPerformance leads" tab + email alert. */
  sheetEndpoint: "https://script.google.com/macros/s/AKfycbzSSvLAyFEfWHhY8NtRJ10-mhLEaOudtEya1JlUjbMDHS_gZjsH-jvHxYmzO21kkP4k/exec"
};
