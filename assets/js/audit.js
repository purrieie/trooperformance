/* TrooPerformance audit: runs Google PageSpeed (mobile + desktop) and the Search/AI scan, animates the scan, then renders the report.
   Everything that comes from a scanned page is escaped before it touches the DOM. */
(function () {
  "use strict";
  var CFG = window.TP_CONFIG || {};
  var doc = document, win = window;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var G = "#4CC38A", A = "#E5A93D", R = "#EF6B57", P = "#A68EFA", DIM = "#6F6C7C";

  // ---------- analytics ----------
  // GTM-WDPL7ZKM routes these dataLayer events: generate_lead -> GA4 + Reddit Lead, book_demo -> GA4,
  // speed_audit_start / speed_audit_result -> GA4. Google Consent Mode decides what GA keeps.
  function track(ev, data) { try { var o = { event: ev }; for (var k in data) o[k] = data[k]; (win.dataLayer = win.dataLayer || []).push(o); } catch (e) {} }
  // For the sheet row: the Apps Script only sends its server-side Lead (same event_id) when meta_consent is true,
  // and passes Meta's browser ids along so it can match the visitor. Empty unless the visitor tapped Accept.
  function metaIds() {
    var ck = function (n) { var m = doc.cookie.match(new RegExp("(?:^|; )" + n + "=([^;]*)")); return m ? decodeURIComponent(m[1]) : ""; };
    var ok = ck("troopod_cookie_consent") === "accepted";
    return { meta_consent: ok, fbp: ok ? ck("_fbp") : "", fbc: ok ? ck("_fbc") : "" };
  }
  // Meta Pixel only exists after cookie consent (see the <head>), so this is a no-op until then.
  function fb(name, data, id, custom) { try { if (typeof win.fbq === "function") win.fbq(custom ? "trackCustom" : "track", name, data || {}, id ? { eventID: id } : {}); } catch (e) {} }

  // ---------- input ----------
  function clean(v) {
    v = String(v || "").trim().replace(/\s+/g, "");
    if (!v) return "";
    v = v.replace(/^https?:\/\//i, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(v)) return "";
    return "https://" + v;
  }
  var qs = new URLSearchParams(location.search);
  var URL0 = clean(qs.get("url"));
  if (!URL0) { location.replace("design/"); return; }
  var VS = String(qs.get("vs") || "").split(",").map(clean).filter(Boolean).slice(0, 2);
  var host = function (u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } };
  var shortUrl = function (u) { return String(u).replace(/^https?:\/\//, "").replace(/\/$/, ""); };

  var S = { psi: { mobile: null, desktop: null }, psiErr: {}, scan: null, scanErr: null, comps: VS.map(function (u) { return { url: u, psi: null, scan: null }; }), device: "mobile", tab: "speed" };

  // ---------- API ----------
  function timeoutFetch(url, opts, ms) {
    var ctl = win.AbortController ? new AbortController() : null;
    var t = ctl ? setTimeout(function () { ctl.abort(); }, ms) : 0;
    opts = opts || {}; if (ctl) opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(t); });
  }
  function api(path, body, ms) {
    return timeoutFetch(CFG.api + path, {
      method: body ? "POST" : "GET",
      headers: Object.assign({ authorization: "Bearer " + CFG.anonKey, apikey: CFG.anonKey }, body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify(body) : undefined
    }, ms || 45000);
  }
  function runScan(u) {
    return api("/scan", { url: u }, 45000).then(function (r) { return r.json(); }).then(function (d) { if (!d || d.error) throw new Error((d && d.error) || "scan_failed"); return d; });
  }
  function psiDirect(u, strategy) {
    var p = new URLSearchParams({ url: u, strategy: strategy });
    ["performance", "seo", "accessibility", "best-practices"].forEach(function (c) { p.append("category", c); });
    if (CFG.psiKey) p.set("key", CFG.psiKey);
    return timeoutFetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + p, {}, 150000).then(function (r) { return r.json(); });
  }
  // Google sometimes fails a single Lighthouse run; retry once unless it's a quota error.
  function runPsi(u, strategy) {
    return runPsiOnce(u, strategy).catch(function (e) {
      if (e && e.message === "busy") throw e;
      return runPsiOnce(u, strategy);
    });
  }
  function runPsiOnce(u, strategy) {
    return api("/psi?url=" + encodeURIComponent(u) + "&strategy=" + strategy, null, 115000)
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, d: d }; }); })
      .catch(function () { return { status: 0, d: null }; })
      .then(function (x) {
        if (x.d && x.d.lighthouseResult) return x.d;
        return psiDirect(u, strategy);
      })
      .then(function (d) {
        if (!d || !d.lighthouseResult) {
          var msg = d && d.error && d.error.message ? d.error.message : "";
          throw new Error(/quota|rate/i.test(msg) ? "busy" : "failed");
        }
        return compactPsi(d);
      });
  }

  // ---------- PSI compaction ----------
  var CAUSES = [
    { id: "images", re: /image|offscreen|lcp-lazy|prioritize-lcp|lcp-discovery|efficient-animated/, title: "Heavy or late images", plain: "Your main images are too big or start loading late, so shoppers stare at empty boxes.", who: "Developer" },
    { id: "apps", re: /third-part/, title: "Apps and tracking scripts", plain: "Third-party apps (reviews, chat, pixels, popups) hog the phone before shoppers can tap.", who: "You + developer" },
    { id: "js", re: /unused-javascript|legacy-javascript|duplicated-javascript|bootup|unminified-javascript|forced-reflow|mainthread/, title: "Too much JavaScript", plain: "Theme and app code runs on load even though the page doesn't need it yet.", who: "Developer" },
    { id: "render", re: /render-blocking|unused-css|unminified-css|critical-request|network-dependency/, title: "Code that blocks the first paint", plain: "The browser has to finish these files before it can show anything.", who: "Developer" },
    { id: "fonts", re: /font/, title: "Fonts hide your text", plain: "Text stays invisible while custom fonts download.", who: "Developer" },
    { id: "layout", re: /layout-shift|cls-culprits|unsized/, title: "The page jumps while loading", plain: "Things pop in late and push content down, so shoppers tap the wrong thing.", who: "Developer" },
    { id: "server", re: /server-response|document-latency|redirects|preconnect|modern-http|cache|text-compression/, title: "Slow start before anything loads", plain: "Redirects, server response or caching add delay before the page even starts.", who: "Developer / hosting" },
    { id: "dom", re: /dom-size/, title: "Page is heavy to draw", plain: "Thousands of elements make every scroll and tap slower.", who: "Developer" }
  ];
  var SKIP = /largest-contentful-paint-element|lcp-breakdown|inp-breakdown|viewport-insight|^interactive$|^first-contentful-paint$|^largest-contentful-paint$|^speed-index$|^total-blocking-time$|^cumulative-layout-shift$|total-byte-weight|network-requests|^server-response-time$/;
  function compactPsi(d) {
    var lr = d.lighthouseResult || {}, a = lr.audits || {}, cat = lr.categories || {};
    var sc = function (k) { return cat[k] && typeof cat[k].score === "number" ? Math.round(cat[k].score * 100) : null; };
    var nv = function (k) { return a[k] && typeof a[k].numericValue === "number" ? a[k].numericValue : null; };
    var le = d.loadingExperience && d.loadingExperience.metrics ? d.loadingExperience : null;
    var ole = d.originLoadingExperience && d.originLoadingExperience.metrics ? d.originLoadingExperience : null;
    var src = le && !le.origin_fallback ? le : (ole || le);
    var scope = le && !le.origin_fallback ? "page" : "site";
    var pct = function (m) { return src && src.metrics[m] && typeof src.metrics[m].percentile === "number" ? src.metrics[m].percentile : null; };
    var field = src ? { lcp: pct("LARGEST_CONTENTFUL_PAINT_MS"), inp: pct("INTERACTION_TO_NEXT_PAINT"), cls: pct("CUMULATIVE_LAYOUT_SHIFT_SCORE") != null ? pct("CUMULATIVE_LAYOUT_SHIFT_SCORE") / 100 : null, fcp: pct("FIRST_CONTENTFUL_PAINT_MS"), ttfb: pct("EXPERIMENTAL_TIME_TO_FIRST_BYTE"), scope: scope } : null;
    if (field && field.lcp == null && field.inp == null && field.cls == null) field = null;
    var thumbs = ((a["screenshot-thumbnails"] || {}).details || {}).items || [];
    var shot = ((a["final-screenshot"] || {}).details || {}).data || "";
    // Lighthouse 12 has third-party-summary (with blocking time); newer versions only have third-parties-insight (main-thread time).
    var tpItems = (((a["third-party-summary"] || {}).details || {}).items || []);
    if (!tpItems.length) tpItems = (((a["third-parties-insight"] || {}).details || {}).items || []);
    var hasBlock = tpItems.some(function (it) { return typeof it.blockingTime === "number"; });
    var third = tpItems.map(function (it) {
      var e = it.entity, size = it.transferSize;
      return { name: typeof e === "string" ? e : (e && (e.text || e.name)) || "Unknown", size: size || 0, main: it.mainThreadTime || 0, cost: hasBlock ? (it.blockingTime || 0) : (it.mainThreadTime || 0) };
    }).sort(function (x, y) { return y.cost - x.cost; });
    var groups = {};
    Object.keys(a).forEach(function (k) {
      var x = a[k]; if (!x || SKIP.test(k) || x.score == null || x.score >= 0.9) return;
      var ms = x.metricSavings || {}, det = x.details || {};
      var sav = Math.max(ms.LCP || 0, ms.FCP || 0, det.overallSavingsMs || 0), tbt = ms.TBT || 0, cls = ms.CLS || 0;
      if (!sav && !tbt && !cls) return;
      var c = null; for (var i = 0; i < CAUSES.length; i++) if (CAUSES[i].re.test(k)) { c = CAUSES[i]; break; }
      if (!c) return;
      var g = groups[c.id] || (groups[c.id] = { id: c.id, title: c.title, plain: c.plain, who: c.who, sav: 0, tbt: 0, cls: 0, audits: [] });
      g.sav = Math.max(g.sav, sav); g.tbt = Math.max(g.tbt, tbt); g.cls = Math.max(g.cls, cls);
      g.audits.push(x.title + (x.displayValue ? " · " + x.displayValue : ""));
    });
    var causes = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (x, y) { return (y.sav + y.tbt * 0.5 + y.cls * 5000) - (x.sav + x.tbt * 0.5 + x.cls * 5000); });
    causes.forEach(function (c) { c.status = c.sav >= 800 || c.tbt >= 500 || c.cls >= 0.1 ? "fail" : "warn"; });
    return {
      perf: sc("performance"), seo: sc("seo"), a11y: sc("accessibility"), bp: sc("best-practices"),
      m: { fcp: nv("first-contentful-paint"), lcp: nv("largest-contentful-paint"), tbt: nv("total-blocking-time"), cls: nv("cumulative-layout-shift"), si: nv("speed-index") },
      field: field, thirdBlock: hasBlock, thumbs: thumbs.map(function (t) { return { t: t.timing, src: t.data }; }), shot: shot, third: third, causes: causes
    };
  }

  // ---------- formatting ----------
  var band = function (n) { return n == null ? DIM : n >= 90 ? G : n >= 50 ? A : R; };
  var bandName = function (n) { return n == null ? "No data" : n >= 90 ? "Good" : n >= 50 ? "Needs work" : "Poor"; };
  var sec = function (ms) { return ms == null ? "—" : (ms / 1000).toFixed(1) + " s"; };
  var msf = function (ms) { return ms == null ? "—" : Math.round(ms).toLocaleString("en-IN") + " ms"; };
  var TH = { fcp: [1800, 3000], lcp: [2500, 4000], tbt: [200, 600], cls: [0.1, 0.25], si: [3400, 5800], inp: [200, 500] };
  var mcol = function (k, v) { if (v == null) return DIM; var t = TH[k]; return v <= t[0] ? G : v <= t[1] ? A : R; };
  function ring(score, size, stroke) {
    var C = 2 * Math.PI * 50, v = score == null ? 0 : score;
    return '<svg class="ring" width="' + size + '" height="' + size + '" viewBox="0 0 120 120" role="img" aria-label="' + (score == null ? "no score" : score + " of 100") + '"><circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="' + stroke + '"/><circle class="val" cx="60" cy="60" r="50" fill="none" stroke="' + band(score) + '" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="0 ' + C.toFixed(1) + '" data-dash="' + (v / 100 * C).toFixed(1) + " " + C.toFixed(1) + '" transform="rotate(-90 60 60)"/><text x="60" y="71" text-anchor="middle" font-size="32" fill="#F4F3F8">' + (score == null ? "–" : score) + "</text></svg>";
  }
  function animateRings(root) { requestAnimationFrame(function () { requestAnimationFrame(function () { (root || doc).querySelectorAll("circle.val[data-dash]").forEach(function (c) { c.setAttribute("stroke-dasharray", c.getAttribute("data-dash")); }); }); }); }
  function toast(t) { var el = $("#toast"); el.textContent = t; el.classList.add("on"); setTimeout(function () { el.classList.remove("on"); }, 2200); }

  // ---------- scan screen ----------
  $("#scanUrl").textContent = shortUrl(URL0);
  doc.title = "Auditing " + host(URL0) + " | TrooPerformance";
  var STAGES = [["mobile", "Loading on a phone"], ["field", "Real-shopper data"], ["google", "Google's view"], ["ai", "AI bots"], ["desktop", "Desktop"]];
  if (VS.length) STAGES.push(["comps", "Competitors"]);
  $("#stages").innerHTML = STAGES.map(function (s) { return '<span class="stage" id="st-' + s[0] + '"><i></i>' + s[1] + "</span>"; }).join("");
  function stage(id, st) { var el = $("#st-" + id); if (el) el.className = "stage " + st; }
  function meter(id, name, score, sub, subColor) {
    $("#m-" + id).innerHTML = ring(score, 74, 10) + '<div class="lbl"><b>' + esc(name) + '</b><span style="color:' + (subColor || DIM) + '">' + esc(sub) + "</span></div>";
    animateRings($("#m-" + id));
  }
  meter("speed", "Performance", null, "measuring…"); meter("search", "Search", null, "measuring…"); meter("ai", "AI answers", null, "measuring…");
  var logEl = $("#log");
  function log(text, tag, tagColor, kind) {
    var d = doc.createElement("div"); d.className = "log-line " + (kind || "sub");
    d.innerHTML = '<span class="t">' + esc(text) + "</span>" + (tag ? '<span class="tag" style="color:' + (tagColor || DIM) + '">' + esc(tag) + "</span>" : "");
    logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
  }
  // live view: the real page with the agents working on it (assets/js/live.js)
  var LV = win.TPLive || { start: function () {}, agent: function () {}, result: function () {}, shot: function () {}, finish: function () { return Promise.resolve(); } };
  function startScan() {
  var t0 = Date.now();
  var clock = setInterval(function () { var c = $("#clock"); if (c) c.textContent = ((Date.now() - t0) / 1000).toFixed(1) + " s"; }, 100);
  LV.start(URL0);
  setTimeout(function () { LV.agent("speed", "run"); LV.agent("search", "run"); }, 1200);
  setTimeout(function () { LV.agent("ai", "run"); LV.agent("desk", "run"); }, 2600);
  var total = 3 + VS.length, done = 0;
  function tick() {
    done++; var p = Math.min(100, Math.round(done / total * 100));
    $("#progBar").style.width = p + "%"; $("#prog").setAttribute("aria-valuenow", p);
    $("#scanPct").textContent = p >= 100 ? "Done" : "Scanning " + p + "%";
  }
  setTimeout(function () { $("#progBar").style.width = "6%"; $("#scanPct").textContent = "Scanning"; }, 200);

  log("→ load on a phone · Google PageSpeed", "", "", "head");
  log("→ read raw HTML, robots.txt, llms.txt, sitemap", "", "", "head");
  stage("mobile", "active"); stage("google", "active");

  var pScan = runScan(URL0).then(function (d) {
    S.scan = d; stage("google", "done"); stage("ai", "active");
    log("→ " + host(d.finalUrl || URL0) + " · status " + d.status + (d.platform ? " · " + d.platform : ""), "", "", "head");
    if (d.limited) {
      log(d.blocked ? "your firewall blocked the check" : "page returns " + d.status, "fail", R);
    } else {
      var h = d.html;
      log("title: " + (h.title || "(none)").slice(0, 46), h.title.length && h.title.length <= 65 ? "ok" : "check", h.title.length && h.title.length <= 65 ? G : A);
      log("structured data: " + (h.jsonld.types.slice(0, 3).join(", ") || "none"), h.jsonld.blocks ? "found" : "missing", h.jsonld.blocks ? G : R);
      log("raw HTML: " + h.words + " words readable without JS", h.words >= 150 ? "ok" : "low", h.words >= 150 ? G : R);
    }
    var blocked = d.robots.bots.filter(function (b) { return !b.allowed && b.ua !== "Googlebot" && b.ua !== "Bingbot"; });
    if (blocked.length) blocked.slice(0, 3).forEach(function (b) { log("robots.txt: " + b.ua + " " + (b.rule || "blocked"), "blocked", R); });
    else log("robots.txt: AI crawlers allowed", "ok", G);
    log("llms.txt", d.llms.found ? "found" : "missing", d.llms.found ? G : A);
    meter("search", "Search", d.search.score, bandName(d.search.score), band(d.search.score));
    meter("ai", "AI answers", d.ai.score, bandName(d.ai.score), band(d.ai.score));
    stage("ai", "done");
    liveScan(d);
  }).catch(function () {
    S.scanErr = true; stage("google", "err"); stage("ai", "err");
    LV.agent("search", "fail", "Couldn't read the HTML"); LV.agent("ai", "fail", "Couldn't read the HTML");
    log("couldn't read this page's HTML", "error", R);
    meter("search", "Search", null, "couldn't check", R); meter("ai", "AI answers", null, "couldn't check", R);
  }).then(tick);

  track("speed_audit_start", { store: host(URL0) });
  fb("AuditStart", { content_name: "TrooPerformance audit" }, "", true);
  var pMob = runPsi(URL0, "mobile").then(function (m) {
    S.psi.mobile = m; stage("mobile", "done");
    log("→ phone test done", "", "", "head");
    log("first paint " + sec(m.m.fcp), sec(m.m.fcp), mcol("fcp", m.m.fcp));
    log("main content (LCP)", sec(m.m.lcp), mcol("lcp", m.m.lcp));
    log("blocked time (TBT)", msf(m.m.tbt), mcol("tbt", m.m.tbt));
    if (m.third.length) log(m.third.length + " third-party services · " + msf(m.third.reduce(function (s, x) { return s + x.cost; }, 0)) + (m.thirdBlock ? " blocking" : " of phone CPU"), "", A);
    if (m.field) { stage("field", "done"); log("real shoppers: LCP " + sec(m.field.lcp) + " · INP " + msf(m.field.inp), m.field.scope === "site" ? "site-wide" : "this page", mcol("lcp", m.field.lcp)); }
    else { stage("field", "done"); log("real-shopper data: not enough Chrome traffic", "n/a", DIM); }
    meter("speed", "Performance", m.perf, bandName(m.perf) + " · mobile", band(m.perf));
    LV.shot(m.shot || (m.thumbs.length ? m.thumbs[m.thumbs.length - 1].src : ""));
    livePsi(m);
  }).catch(function (e) {
    S.psiErr.mobile = e && e.message || "failed"; stage("mobile", "err"); stage("field", "err");
    log("Google PageSpeed " + (S.psiErr.mobile === "busy" ? "is busy right now" : "didn't answer"), "retry later", A);
    meter("speed", "Performance", null, "PageSpeed busy", A);
    LV.agent("speed", "fail", "Google PageSpeed is busy");
  }).then(tick);
  stage("field", "active");

  S.pendingDesktop = true;
  var pDesk = runPsi(URL0, "desktop").then(function (m) {
    S.psi.desktop = m; stage("desktop", "done"); log("desktop score", String(m.perf), band(m.perf));
    LV.agent("desk", "done", "Desktop score " + m.perf);
  }).catch(function (e) { S.psiErr.desktop = e && e.message || "failed"; stage("desktop", "err"); LV.agent("desk", "fail", "Google PageSpeed is busy"); }).then(function () {
    S.pendingDesktop = false; tick();
    if (S.shown) { var rep = $("#report"); rep.innerHTML = renderReport(); animateRings(rep); }
  });
  stage("desktop", "active");

  var pComps = S.comps.map(function (c) {
    stage("comps", "active");
    return Promise.all([
      runScan(c.url).then(function (d) { c.scan = d; }).catch(function () {}),
      runPsi(c.url, "mobile").then(function (m) { c.psi = m; }).catch(function () {})
    ]).then(function () {
      log("→ " + host(c.url), "speed " + (c.psi ? c.psi.perf : "–") + " · search " + (c.scan ? c.scan.search.score : "–") + " · AI " + (c.scan ? c.scan.ai.score : "–"), P, "head");
    }).then(tick);
  });

  // Show the report once the phone test, the scan and competitors are in. Desktop fills in when it lands.
  Promise.all([pScan, pMob].concat(pComps)).then(function () {
    if (VS.length) stage("comps", "done");
    clearInterval(clock); $("#spin").style.display = "none";
    log("report ready", "done", G, "head");
    var shown = false, go = function () { if (!shown) { shown = true; showReport(); } };
    setTimeout(function () { LV.finish().then(go); }, 2600);
    setTimeout(go, 7000);
  });
  }

  // ---------- saved reports: audit.html?url=..&r=<id> reopens the report the visitor already got, no new scan ----------
  // Saved when they unlock the full report (and again after a competitor test); kept 30 days, then the link runs a fresh scan.
  var RH = function () { return { authorization: "Bearer " + CFG.anonKey, apikey: CFG.anonKey, "content-type": "application/json" }; };
  var RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(qs.get("r") || "") ? qs.get("r") : "";
  S.snapId = "";
  function openSaved(id) {
    $("#scanPct").textContent = "Opening your report\u2026";
    timeoutFetch(CFG.reportApi + "/snap?id=" + id, { headers: RH() }, 12000)
      .then(function (r) { if (!r.ok) throw new Error("gone"); return r.json(); })
      .then(function (d) {
        var s = d && d.snap;
        if (!s || s.v !== 1 || host(s.url) !== host(URL0)) throw new Error("bad");
        S.psi = { mobile: (s.psi && s.psi.mobile) || null, desktop: (s.psi && s.psi.desktop) || null }; S.psiErr = s.psiErr || {};
        S.scan = s.scan || null; S.scanErr = s.scanErr || null; S.comps = Array.isArray(s.comps) ? s.comps : [];
        S.cmp = { state: s.cmp && s.cmp.state === "done" && s.cmp.list && s.cmp.list.length ? "done" : "empty", inputs: ((s.cmp && s.cmp.inputs) || []).concat(["", "", ""]).slice(0, 3), list: (s.cmp && s.cmp.list) || [], auto: !!(s.cmp && s.cmp.auto) };
        S.pendingDesktop = false; S.unlocked = true; S.snapId = id; S.saved = { at: d.at || s.at };
        $("#spin").style.display = "none";
        showReport();
      })
      .catch(function () {
        try { var q = new URLSearchParams(location.search); q.delete("r"); history.replaceState(null, "", "?" + q.toString()); } catch (e) {}
        startScan();
        setTimeout(function () { toast("That saved report has expired, so here\u2019s a fresh scan."); }, 600);
      });
  }
  function snapshot() {
    var lite = function (p, film) { if (!p) return p; var o = Object.assign({}, p); delete o.shot; if (!film) o.thumbs = []; return o; };
    var done = S.cmp && S.cmp.state === "done";
    return {
      v: 1, url: URL0, at: new Date().toISOString(),
      psi: { mobile: lite(S.psi.mobile, true), desktop: lite(S.psi.desktop, true) }, psiErr: S.psiErr || {}, scan: S.scan, scanErr: S.scanErr || null,
      comps: S.comps.map(function (c) { return { url: c.url, psi: lite(c.psi), scan: c.scan }; }),
      cmp: { state: done ? "done" : "empty", inputs: (S.cmp && S.cmp.inputs) || [], auto: !!(S.cmp && S.cmp.auto), list: done ? S.cmp.list.map(function (x) { return { url: x.url, psi: lite(x.psi), pending: false }; }) : [] }
    };
  }
  function saveSnap() {
    if (!CFG.reportApi || !win.fetch) return Promise.resolve();
    return timeoutFetch(CFG.reportApi + "/snap", { method: "POST", headers: RH(), body: JSON.stringify({ site: host(URL0), snap: snapshot() }) }, 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.id) return;
        S.snapId = d.id;
        try { var q = new URLSearchParams(location.search); q.set("r", d.id); history.replaceState(null, "", "?" + q.toString()); } catch (e) {}
      })
      .catch(function () {});
  }
  if (RID && CFG.reportApi) openSaved(RID); else startScan();

  // what the agents pin on the live page
  function kindOf(c) { return c === G ? "ok" : c === A ? "warn" : "bad"; }
  function livePsi(m) {
    var x = m.m;
    if (x.lcp != null) LV.result("speed", "img", kindOf(mcol("lcp", x.lcp)), "Main content shows at " + sec(x.lcp));
    if (x.tbt != null) LV.result("speed", "cta", kindOf(mcol("tbt", x.tbt)), "Taps blocked for " + msf(x.tbt));
    if (x.cls != null) LV.result("speed", "content", kindOf(mcol("cls", x.cls)), "Layout shift " + x.cls.toFixed(2));
    if (m.third.length) LV.result("speed", "nav", m.third.length > 8 ? "warn" : "ok", m.third.length + " third-party apps load");
    LV.agent("speed", "done", "Performance " + (m.perf == null ? "–" : m.perf) + " on a phone");
  }
  function liveScan(d) {
    var h = d.html;
    if (h) {
      var tl = (h.title || "").length;
      LV.result("search", "title", h.h1Count === 1 ? "ok" : h.h1Count ? "warn" : "bad", h.h1Count === 1 ? "One clear H1" : h.h1Count ? h.h1Count + " H1 headings" : "No H1 heading");
      LV.result("search", "nav", tl && tl <= 65 ? "ok" : "warn", tl ? (tl <= 65 ? "Title fits in Google" : "Title gets cut off") : "No page title");
      if (h.imgs) LV.result("search", "img", h.imgsNoAlt ? (h.imgsNoAlt / h.imgs > 0.3 ? "bad" : "warn") : "ok", h.imgsNoAlt ? h.imgsNoAlt + " images without alt text" : "Every image has alt text");
      var p = h.jsonld.product;
      if (d.isProduct) LV.result("ai", "price", p && p.price ? "ok" : h.price ? "warn" : "bad", p && p.price ? "Price readable by AI" : h.price ? "Price not in schema" : "AI can't see the price");
      LV.result("ai", "content", h.words >= 150 ? "ok" : "bad", h.words + " words readable without JS");
    }
    var blocked = d.robots.bots.filter(function (b) { return !b.allowed && b.ua !== "Googlebot" && b.ua !== "Bingbot"; });
    LV.result("ai", "footer", blocked.length ? "bad" : "ok", blocked.length ? blocked.length + " AI bots blocked" : "AI bots allowed");
    LV.agent("search", "done", "Search " + d.search.score + "/100");
    LV.agent("ai", "done", "AI answers " + d.ai.score + "/100");
  }

  // ---------- report ----------
  function showReport() {
    if (!S.shown && !S.saved) track("speed_audit_result", { store: host(URL0), speed_score: S.psi.mobile ? S.psi.mobile.perf : null });
    S.shown = true;
    if (S.comps.length && S.cmp.state === "empty" && S.psi.mobile) { S.cmp.state = "done"; S.cmp.list = S.comps.map(function (c) { return { url: c.url, psi: c.psi, pending: false }; }); }
    if (!S.psi.mobile && S.scan) S.tab = "search";
    doc.title = host(URL0) + " · site audit | TrooPerformance";
    $("#scan").hidden = true;
    var rep = $("#report"); rep.hidden = false;
    rep.innerHTML = renderReport();
    bindReport();
    animateRings(rep);
    win.scrollTo({ top: 0 });
  }

  function checkRow(c, impact, impColor) {
    return '<div class="check"><span class="st ' + c.status + '">' + (c.status === "fail" ? "Fail" : c.status === "warn" ? "Warn" : "Pass") + '</span><div class="ct"><b>' + esc(c.title) + "</b><span>" + esc(c.why || "") + "</span>" + (c.detail ? "<code>" + esc(String(c.detail).slice(0, 140)) + "</code>" : "") + "</div>" + (impact ? '<span class="imp" style="color:' + (impColor || DIM) + '">' + esc(impact) + "</span>" : "<span></span>") + "</div>";
  }
  function checksBlock(list) {
    var bad = list.filter(function (c) { return c.status !== "pass"; }).sort(function (a, b) { return (a.status === "fail" ? 0 : 1) - (b.status === "fail" ? 0 : 1); });
    var good = list.filter(function (c) { return c.status === "pass"; });
    return (bad.length ? bad.map(function (c) { return checkRow(c); }).join("") : '<div class="check"><span class="st pass">Pass</span><div class="ct"><b>Nothing failing here</b><span>Every check passed.</span></div><span></span></div>') +
      (good.length ? '<details class="passes"><summary>' + good.length + " passed checks</summary>" + good.map(function (c) { return checkRow(c); }).join("") + "</details>" : "");
  }
  function impactOf(c) {
    if (c.sav >= 100) return ["−" + (c.sav / 1000).toFixed(1) + " s", G];
    if (c.tbt >= 50) return ["−" + Math.round(c.tbt).toLocaleString("en-IN") + " ms blocking", G];
    if (c.cls) return ["CLS −" + c.cls.toFixed(2), A];
    return ["minor", DIM];
  }

  function headline() {
    var m = S.psi.mobile, d = S.scan;
    var lcp = m ? (m.field && m.field.lcp) || m.m.lcp : null;
    var real = !!(m && m.field && m.field.lcp);
    var oai = d && d.robots.bots.filter(function (b) { return b.ua === "OAI-SearchBot"; })[0];
    if (lcp && lcp > 2500) return { h: "Your page takes <span class=\"hl\">" + (lcp / 1000).toFixed(1) + " seconds</span> to show up on a phone.", l: real ? "That's what your real shoppers wait, per Chrome's own data. It's your biggest leak. Below is everything else, sorted by what it costs you." : "That's Google's phone test. It's your biggest leak. Below is everything else, sorted by what it costs you." };
    if (m && m.perf != null && m.perf < 50) return { h: "Google rates your mobile performance <span class=\"hl\">" + m.perf + " out of 100.</span>", l: (real ? "Real shoppers see your main content in " + (lcp / 1000).toFixed(1) + " s, but the lab test shows how slow the page is on a mid-range phone. " : "") + "Below is everything holding your store back, sorted by what it costs you." };
    if (d && d.blocked) return { h: "Your firewall turns <span class=\"hl\">automated visitors away.</span>", l: "Your page couldn't be read, and AI assistants probably can't read it either. Here's what your store shows from the outside." };
    if (oai && !oai.allowed) return { h: "ChatGPT <span class=\"hl\">can't read your store.</span>", l: "Your robots.txt blocks ChatGPT's search crawler. Below is everything holding your store back, sorted by what it costs you." };
    if (d && d.ai.score != null && d.ai.score < 60) return { h: "AI assistants <span class=\"hl\">can barely see your store.</span>", l: "Below is everything holding your store back, sorted by what it costs you." };
    if (d && d.search.score != null && d.search.score < 70) return { h: "Google sees <span class=\"hl\">a weaker version of your store.</span>", l: "Below is everything holding your store back, sorted by what it costs you." };
    return { h: "Your store is in good shape. <span class=\"hl\">Here's what's left.</span>", l: "Below is everything holding your store back, sorted by what it costs you." };
  }

  function appsBlock(m) {
    var apps = "";
    if (m.third.length) {
      var top = m.third.filter(function (x) { return x.cost >= 1 || x.main >= 50; }).slice(0, 8), mx = Math.max.apply(null, top.map(function (x) { return x.cost || 1; }).concat([1]));
      var tb = m.third.reduce(function (s, x) { return s + x.cost; }, 0), tk = m.third.reduce(function (s, x) { return s + x.size; }, 0);
      var costLabel = m.thirdBlock ? "Blocks the page for" : "Phone CPU time";
      var showSize = m.third.some(function (x) { return x.size > 0; });
      apps = '<div class="apps"><div class="head"><div><h3 class="h3" style="font-size:20px">App tax</h3><span class="small">Every third-party script on this page and what it costs a ' + S.device + " shopper</span></div><span class=\"mono\" style=\"font-size:13px;color:" + (tb > 500 ? R : A) + '">' + (showSize ? Math.round(tk / 1024).toLocaleString("en-IN") + " KB · " : "") + msf(tb) + (m.thirdBlock ? " blocking" : " CPU") + '</span></div><table><thead><tr><th scope="col">App / service</th><th scope="col" style="width:' + (showSize ? 46 : 62) + '%">' + costLabel + '</th>' + (showSize ? '<th scope="col">Size</th>' : '') + '</tr></thead><tbody>' +
        top.map(function (x, i) { var v = x.cost || 0, hi = m.thirdBlock ? 250 : 500, mid = m.thirdBlock ? 50 : 150, col = v >= hi ? R : v >= mid ? A : "#8B8BA0"; return '<tr><th scope="row" style="font-weight:400;text-align:left">' + esc(x.name) + '</th><td><div class="bar"><div><i style="width:' + Math.max(2, v / mx * 100) + "%;background:" + col + ";animation-delay:" + (i * 0.06) + 's"></i></div><span>' + msf(v) + '</span></div></td>' + (showSize ? '<td class="mono" style="color:#A09DAD">' + Math.round(x.size / 1024).toLocaleString("en-IN") + " KB</td>" : "") + "</tr>"; }).join("") +
        "</tbody></table></div>";
    }
    return apps;
  }

  // ---------- speed card (v3 design): score today → with TrooPerformance, Core Web Vitals cards with Google impact lines ----------
  S.open = { si: false, lcp: false, inp: false };
  function uplift(score, domain) {
    var h = 0; for (var i = 0; i < domain.length; i++) h = (h * 31 + domain.charCodeAt(i)) >>> 0;
    var jit = [-2, -1, 1, 2][h % 4];
    var base = score < 20 ? 15 + (h % 6) : score < 50 ? 15 + jit : score < 60 ? 10 + jit : 5 + jit;
    var gain = Math.max(1, Math.min(base, 99 - score));
    // Case study (a billion-dollar house of brands): +29.2 points lifted conversion rate 19%.
    var c = gain * (19 / 29.2) / 100, aov = c * (9.2 / 8.4);
    // Revenue = more orders x bigger orders. Deloitte x Google saw order value rise 9.2% alongside 8.4% more conversions.
    return { gain: gain, target: score + gain, conv: Math.round(c * 1000) / 10, rev: Math.round(((1 + c) * (1 + aov) - 1) * 1000) / 10 };
  }
  function bigRing(v, color, label, sub, subColor, delay) {
    var C = 2 * Math.PI * 86, d = (Math.max(0, Math.min(100, v)) / 100 * C).toFixed(1) + " " + C.toFixed(1);
    return '<div class="sp-ringw"><svg viewBox="0 0 200 200" class="sp-ring" role="img" aria-label="' + esc(label) + " " + v + ' out of 100"><circle cx="100" cy="100" r="86" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="14"/><circle class="val" cx="100" cy="100" r="86" fill="none" stroke="' + color + '" stroke-width="14" stroke-linecap="round" stroke-dasharray="0 ' + C.toFixed(1) + '" data-dash="' + d + '" transform="rotate(-90 100 100)" style="transition-delay:' + (delay || 0) + 's"/><text x="100" y="112" text-anchor="middle" font-size="54" fill="' + (color === P ? "#CBBEFD" : "#F4F3F8") + '" font-family="DM Mono, monospace">' + v + '</text><text x="100" y="138" text-anchor="middle" font-size="13" fill="#A09DAD" font-family="DM Mono, monospace">/ 100</text></svg><span class="sp-ringl">' + label + '<br><span style="color:' + subColor + '">' + sub + "</span></span></div>";
  }
  var DEFS = {
    si: "How quickly the visible part of your page fills in while it loads. A page that shows most of its content early scores better than one that pops in all at the end. Google calls it good under 3.4 s on a phone.",
    lcp: "The moment the biggest thing on screen, usually your product photo or banner, finishes showing. It is when shoppers feel the page has loaded. Good is 2.5 s or less; over 4 s is poor.",
    inp: "How long the page takes to react after a shopper taps, clicks or types, like Add to cart or picking a shade. Measured on real visits. Good is 200 ms or less; over 500 ms is poor.",
    tbt: "How long the page is frozen while scripts run, so taps can't respond. It's the lab stand-in for INP until Chrome has enough real visits. Good is 200 ms or less; over 600 ms is poor."
  };
  function vitalCard(k, abbr, name, v, thKey, fmt, field, impact, source) {
    var t = TH[thKey], col = mcol(thKey, v), bn = v == null ? "No data" : v <= t[0] ? "Good" : v <= t[1] ? "Needs work" : "Poor";
    var max = Math.max((v || 0) * 1.15, t[1] * 1.6), open = !!S.open[k];
    var pos = v == null ? 0 : Math.min(97, v / max * 100);
    return '<article class="sp-vital"><div class="sp-vh"><div><span class="sp-abbr">' + abbr + '</span><h4>' + name + '</h4></div><button type="button" class="sp-plus" data-def="' + k + '" aria-expanded="' + open + '" aria-label="What is ' + esc(name) + '?">' + (open ? "−" : "+") + "</button></div>" +
      (open ? '<div class="sp-def">' + DEFS[k === "inp" && thKey === "tbt" ? "tbt" : k] + "</div>" : "") +
      '<div class="sp-val"><span style="color:' + col + '">' + (v == null ? "—" : fmt(v)) + '</span><em style="color:' + col + ";border-color:" + col + '">' + bn + "</em></div>" +
      (v == null ? "" : '<div class="sp-bar"><div class="sp-track"><i style="width:' + (t[0] / max * 100).toFixed(1) + '%"></i><i style="width:' + ((t[1] - t[0]) / max * 100).toFixed(1) + '%"></i><i></i><b style="left:' + pos.toFixed(1) + '%"></b></div><div class="sp-scale"><span>Good ≤ ' + fmt(t[0]) + "</span><span>Poor &gt; " + fmt(t[1]) + "</span></div></div>") +
      (field ? '<div class="sp-field"><span>Real shoppers, last 28 days</span><b style="color:' + mcol(thKey, field) + '">' + fmt(field) + "</b></div>" : "") +
      '<div class="sp-impact"><span>' + impact + '</span><small>' + source + "</small></div></article>";
  }
  function speedPanel() {
    var m = S.psi[S.device], err = S.psiErr[S.device], dom = host(URL0);
    var toggle = '<span class="devtoggle no-print" role="group" aria-label="Device"><button type="button" data-dev="mobile" aria-pressed="' + (S.device === "mobile") + '">Mobile</button><button type="button" data-dev="desktop" aria-pressed="' + (S.device === "desktop") + '">Desktop</button></span>';
    if (!m && S.device === "desktop" && S.pendingDesktop) {
      return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>Performance · desktop</span>' + toggle + '</p><div class="notice">The desktop test is still running. It will show up here by itself in a few seconds.</div></div></div>';
    }
    if (!m) {
      return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>Performance · ' + S.device + "</span>" + toggle + '</p><div class="notice">' + (err === "busy" ? "Google PageSpeed is busy right now (it limits free tests per day)." : "Google PageSpeed didn't answer for this page.") + ' Try again in a minute.<button class="btn btn-ghost btn-sm" type="button" data-retry>Run speed test again</button></div></div></div>';
    }
    var score = m.perf == null ? 0 : m.perf, up = uplift(score, dom), f = m.field, other = S.device === "mobile" ? S.psi.desktop : S.psi.mobile;
    var cwvPass = f ? (f.lcp != null && f.lcp <= 2500 && (f.inp == null || f.inp <= 200) && (f.cls == null || f.cls <= 0.1)) : null;
    var head = '<div class="sp-head"><div><span class="eyebrow">Performance · ' + esc(dom) + " · tested on a " + (S.device === "mobile" ? "phone" : "desktop") + '</span><h3 class="h3" style="font-size:clamp(24px,2.6vw,32px);margin-top:8px">How fast your store feels</h3></div><div class="sp-chips">' + toggle +
      (other ? '<span class="sp-chip">' + (S.device === "mobile" ? "Desktop" : "Mobile") + ' score <b style="color:' + band(other.perf) + '">' + other.perf + "</b></span>" : S.device === "mobile" && S.pendingDesktop ? '<span class="sp-chip">Desktop score <b style="color:' + DIM + '">testing\u2026</b></span>' : "") +
      (cwvPass == null ? "" : '<span class="sp-chip" style="color:' + (cwvPass ? G : R) + ";border-color:" + (cwvPass ? "rgba(76,195,138,.4)" : "rgba(239,107,87,.4)") + '">Core Web Vitals: ' + (cwvPass ? "passed" : "failed") + "</span>") + "</div></div>";
    var abandon = score >= 90 ? "A score of " + score + " is strong. Google found that when a site meets its Core Web Vitals, shoppers are <b>24% less likely to abandon the page</b> while it loads. Keep it there." : "A score of " + score + " means your page " + (score < 50 ? "struggles" : "is only average") + " on a " + (S.device === "mobile" ? "phone" : "computer") + ". Google found that when a site meets its Core Web Vitals, shoppers are <b>24% less likely to abandon the page</b> while it loads.";
    var hero = '<section class="sp-hero" aria-label="Overall performance score"><div class="sp-dots" aria-hidden="true"></div><div class="sp-hero-row"><div class="sp-rings">' +
      bigRing(score, band(score), "Today", bandName(score), band(score), 0) +
      '<div class="sp-arrow"><span>+' + up.gain + '</span><svg viewBox="0 0 64 20" fill="none" stroke="#A68EFA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 10h58M52 3l8 7-8 7"/></svg></div>' +
      bigRing(up.target, P, "With", "TrooPerformance", "#CBBEFD", 0.4) +
      '</div><div class="sp-copy"><span class="vis-label">Overall performance score · Google PageSpeed, ' + S.device + '</span><h3>See ' + esc(dom) + ' go from <span style="color:' + band(score) + '">' + score + '</span> to <span style="color:#CBBEFD">' + up.target + '</span>.</h3>' +
      '<div class="sp-lift"><span class="c"><b>+' + up.conv + '%</b> conversions</span><span class="r"><b>+' + up.rev + '%</b> revenue</span></div>' +
      '<p class="small" style="margin:0;font-size:13px">Conversions: based on a billion-dollar house of brands case, where +29 points lifted conversion rate 19%. Revenue adds bigger orders: Deloitte \u00d7 Google saw order value rise 9.2% alongside 8.4% more conversions. Same traffic. Estimate, not a guarantee.</p>' +
      '<a class="btn btn-primary" data-calendly href="' + esc(CFG.calendly || "#") + '" target="_blank" rel="noopener" style="align-self:flex-start">Get to ' + up.target + ' <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></a></div></div>' +
      '<div class="sp-quote"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#EF6B57" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7l6 6 4-4 8 8"/><path d="M15 17h6v-6"/></svg><div><span>' + abandon + '</span><small>Google, The Science Behind Web Vitals (Chromium blog), 2020</small></div></div></section>';
    // vitals
    var si = m.m.si, lcp = m.m.lcp, inpF = f && f.inp, tbt = m.m.tbt, s1 = function (ms) { return (ms / 1000).toFixed(1) + " s"; };
    var siImp = si == null ? "Google couldn't measure this one." : si > 3400 ? "Your page fills in " + s1(si - 3400) + " slower than Google’s 3.4 s line. Every 0.1 s faster lifts retail conversions by 8.4%, so every extra second is sales you lose each day." : "You fill in under Google’s 3.4 s line. Worth keeping: every 0.1 s faster lifts retail conversions by 8.4%.";
    var lcpImp = lcp == null ? "Google couldn't measure this one." : lcp > 2500 ? "Your LCP is " + s1(lcp - 2500) + " over Google’s 2.5 s line. Google: every 1 s of delay can cut conversions by up to 20%. That’s up to 20% of sales lost, every day." : "Your main content shows inside Google’s 2.5 s line. Google: every 1 s of delay can cut conversions by up to 20%, so this is worth protecting.";
    var cards = vitalCard("si", "SPEED INDEX", "How fast the page fills in", si, "si", s1, null, siImp, "Deloitte × Google, Milliseconds Make Millions, 2020") +
      vitalCard("lcp", "LCP · LARGEST CONTENTFUL PAINT", "When your main content shows", lcp, "lcp", s1, f && f.lcp, lcpImp, "Google, retail page-load data, 2018");
    if (inpF != null) {
      cards += vitalCard("inp", "INP · INTERACTION TO NEXT PAINT", "How fast taps respond", inpF, "inp", msf, null, inpF > 200 ? "Your INP is " + Math.round(inpF - 200) + " ms over Google’s 200 ms line. When redBus fixed theirs, sales went up 7%. Slow taps cost you that every day." : "Taps respond inside Google’s 200 ms line. When redBus fixed theirs, sales went up 7%, so keep it here.", "Google web.dev case study, redBus, 2023");
    } else {
      cards += vitalCard("inp", "TBT · STAND-IN FOR INP", "How long taps are blocked", tbt, "tbt", msf, null, (tbt != null && tbt > 200 ? "Scripts block taps for " + msf(tbt) + ", over Google’s 200 ms line." : "Scripts barely block taps.") + " Chrome doesn’t have enough real visits for INP yet. When redBus fixed tap speed, sales went up 7%.", "Google web.dev case study, redBus, 2023");
    }
    var vitals = '<div class="sp-vhead"><h3 class="h3">Core Web Vitals that are costing you sales</h3><span class="small">Tap + to see what each one means</span></div><div class="sp-vitals">' + cards + "</div>";
    var lab = '<div class="sp-other">' + [["First paint", "fcp", sec], ["Blocked time", "tbt", msf], ["Layout jumps", "cls", function (v) { return v == null ? "—" : v.toFixed(2); }]].map(function (x) { var v = m.m[x[1]]; return '<div><span>' + x[0] + '</span><b style="color:' + mcol(x[1], v) + '">' + x[2](v) + "</b></div>"; }).join("") + "</div>";
    // what's slowing it down + filmstrip
    var left = '<p class="panel-title"><span>What is slowing it down</span><span>Time saved, Google’s estimate</span></p>' +
      (m.causes.length ? m.causes.map(function (c) { var im = impactOf(c); return checkRow({ status: c.status, title: c.title, why: c.plain + " Who fixes it: " + c.who + ".", detail: c.audits.slice(0, 2).join(" | ") }, im[0], im[1]); }).join("")
        : '<div class="check"><span class="st pass">Pass</span><div class="ct"><b>No big savings left</b><span>Google found nothing major to fix on this page.</span></div><span></span></div>');
    var lcpT = m.m.lcp, film = m.thumbs.slice(0, 8), lcpIdx = -1;
    film.forEach(function (x, i) { if (lcpIdx < 0 && lcpT != null && x.t >= lcpT) lcpIdx = i; });
    var right = "";
    if (film.length) right += '<span class="vis-label">Your page loading, frame by frame' + (lcpT ? " · main content at " + sec(lcpT) : "") + '</span><div class="film">' + film.map(function (x, i) { return '<figure class="' + (i === lcpIdx ? "lcp" : "") + '"><img src="' + esc(x.src) + '" alt="Page at ' + sec(x.t) + '" loading="lazy"><figcaption>' + sec(x.t) + "</figcaption></figure>"; }).join("") + "</div>";
    right += '<div class="pills"><span class="chip">Accessibility ' + (m.a11y == null ? "–" : m.a11y) + '</span><span class="chip">Best practices ' + (m.bp == null ? "–" : m.bp) + '</span><span class="chip">Lighthouse SEO ' + (m.seo == null ? "–" : m.seo) + "</span></div>";
    return '<div class="sp">' + head + hero + vitals + lab + '<div class="panel" style="margin-top:6px"><div class="panel-l">' + left + '</div><div class="panel-r">' + right + "</div></div>" + appsBlock(m) +
      (S.cmp.state === "empty" ? '<button type="button" class="cp-banner no-print" data-cmp-go><span><b>Where do you rank against your competitors?</b><span>Add up to 3 brands and see how your store stacks up on the same phone test.</span></span><span class="btn btn-primary btn-sm">Compare now <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span></button>' : "") + "</div>";
  }

  function searchPanel() {
    var d = S.scan;
    if (!d) return '<div class="panel"><div class="panel-l"><div class="notice">Your page\'s HTML couldn\'t be read, so search checks didn\'t run. <button class="btn btn-ghost btn-sm" type="button" onclick="location.reload()">Run the audit again</button></div></div></div>';
    var h = d.html, right = "";
    if (h) {
      var u; try { u = new URL(d.finalUrl); } catch (e) { u = null; }
      var crumb = u ? host(d.finalUrl) + u.pathname.split("/").filter(Boolean).slice(0, 2).map(function (p) { return " › " + decodeURIComponent(p); }).join("") : host(URL0);
      var t = h.title || "(no title, Google will make one up)", ds = h.desc || "No description. Google will pick a line of text from your page.";
      var p = h.jsonld.product, stars = "";
      if (p && (p.rating || p.price)) {
        var r = parseFloat(p.rating), full = isNaN(r) ? 0 : Math.round(r);
        stars = '<span class="s">' + (p.rating ? "★★★★★".slice(0, full) + "☆☆☆☆☆".slice(0, 5 - full) + " " : "") + "<span>" + esc([p.rating ? p.rating + (p.reviews ? " · " + p.reviews + " reviews" : "") : "", p.price ? (p.currency === "INR" ? "₹" : (p.currency ? p.currency + " " : "")) + p.price : "", p.availability ? p.availability.replace(/([a-z])([A-Z])/g, "$1 $2") : ""].filter(Boolean).join(" · ")) + "</span></span>";
      }
      right += '<span class="vis-label">How this page can show up on Google</span><div class="serp-big"><span class="crumb">' + esc(crumb) + '</span><span class="t">' + esc(t.length > 62 ? t.slice(0, 60) + "…" : t) + "</span>" + stars + '<span class="d">' + esc(ds.length > 158 ? ds.slice(0, 155) + "…" : ds) + "</span></div>";
      right += '<span class="vis-label">Structured data Google can read</span><div class="pills">' + (h.jsonld.types.length ? h.jsonld.types.slice(0, 10).map(function (x) { return '<span class="chip">' + esc(x) + "</span>"; }).join("") : '<span class="chip" style="color:' + R + '">None found</span>') + "</div>";
      right += '<div class="labm"><div><span>Sitemap</span><b style="color:' + (d.sitemap.found ? G : A) + '">' + (d.sitemap.found ? (d.sitemap.urls + (d.sitemap.index ? " maps" : " URLs")) : "missing") + "</b></div><div><span>Images with alt</span><b>" + (h.imgs ? Math.round((h.imgs - h.imgsNoAlt) / h.imgs * 100) + "%" : "—") + "</b></div><div><span>H1 headings</span><b>" + h.h1Count + "</b></div>" + (S.psi.mobile && S.psi.mobile.seo != null ? "<div><span>Lighthouse SEO</span><b style=\"color:" + band(S.psi.mobile.seo) + '">' + S.psi.mobile.seo + "</b></div>" : "") + "</div>";
    } else {
      right += '<div class="notice">' + (d.blocked ? "Your server blocked the check (status " + esc(d.status) + "), so only your robots.txt and sitemap could be read." : "This page returns " + esc(d.status) + ". Check the address and run the audit again.") + "</div>";
    }
    return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>Search checks · score ' + d.search.score + "/100</span><span>" + d.search.checks.length + " checks</span></p>" + checksBlock(d.search.checks) + '</div><div class="panel-r">' + right + "</div></div>";
  }

  function aiPanel() {
    var d = S.scan;
    if (!d) return '<div class="panel"><div class="panel-l"><div class="notice">Your page couldn\'t be read, so AI checks didn\'t run. <button class="btn btn-ghost btn-sm" type="button" onclick="location.reload()">Run the audit again</button></div></div></div>';
    var right = '<span class="vis-label">Which AI crawlers your robots.txt lets in' + (d.robots.found ? "" : " · no robots.txt, so all are allowed") + '</span><div class="bots">' +
      d.robots.bots.map(function (b) { return '<div class="bot"><span>' + esc(b.ua) + "<small>" + esc(b.who) + '</small></span><span class="' + (b.allowed ? "y" : "n") + '">' + (b.allowed ? "allowed" : "blocked") + "</span></div>"; }).join("") + "</div>";
    var h = d.html;
    if (h) {
      var p = h.jsonld.product, lines = [];
      lines.push('<span class="k-m"># what an AI bot reads, no JavaScript</span>');
      lines.push('<span class="k-p">## ' + esc((h.h1 || h.title || "(no heading)").slice(0, 70)) + "</span>");
      if (d.isProduct) lines.push("price: " + (p && p.price ? '<span class="k-g">' + esc((p.currency || "") + " " + p.price) + "</span>" : h.price ? '<span class="k-g">' + esc(h.price) + "</span>" : '<span class="k-r">not in HTML</span>'));
      if (d.isProduct) lines.push("rating: " + (p && p.rating ? '<span class="k-g">' + esc(p.rating + (p.reviews ? " (" + p.reviews + " reviews)" : "")) + "</span>" : '<span class="k-a">not in schema</span>'));
      lines.push("readable text: " + (h.words >= 150 ? '<span class="k-g">' : '<span class="k-r">') + h.words + " words</span>");
      lines.push("faq: " + (h.jsonld.faqPage ? '<span class="k-g">marked up</span>' : h.faqText ? '<span class="k-a">on page, not marked up</span>' : '<span class="k-a">none</span>'));
      lines.push("llms.txt: " + (d.llms.found ? '<span class="k-g">found</span>' : '<span class="k-a">missing</span>'));
      if (h.agentText) lines.push('<span class="k-m">' + esc(h.agentText.slice(0, 220)) + "…</span>");
      right += '<span class="vis-label">Agent view of this page</span><pre class="agent" style="height:auto;max-width:none">' + lines.join("\n") + "</pre>";
    }
    return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>AI answer checks · score ' + d.ai.score + "/100</span><span>ChatGPT · Perplexity · Gemini · Claude</span></p>" + checksBlock(d.ai.checks) + '</div><div class="panel-r">' + right + "</div></div>";
  }

  // ---------- compare with competitors (unlocks after the first run): same phone test on up to 3 brands ----------
  S.cmp = { state: "empty", inputs: ["", "", ""], list: [] };
  if (S.comps.length) { S.cmp.inputs = VS.concat(["", "", ""]).slice(0, 3).map(shortUrl); }
  function cmpRows() {
    var you = { url: URL0, psi: S.psi.mobile, you: true };
    var all = [you].concat(S.cmp.list).filter(function (c) { return c.psi && c.psi.perf != null; });
    all.sort(function (a, b) { return b.psi.perf - a.psi.perf || (a.psi.m.lcp || 9e9) - (b.psi.m.lcp || 9e9); });
    return all;
  }
  function tapVal(p) { return p.field && p.field.inp != null ? { v: p.field.inp, k: "inp", lab: false } : { v: p.m.tbt, k: "tbt", lab: true }; }
  function compareInner() {
    var c = S.cmp, dom = host(URL0);
    var head = '<div class="rep-sec-head"><div style="display:flex;flex-direction:column;gap:10px"><span class="eyebrow">Phone test · same moment · same settings</span><h2 class="h2">You vs <span class="hl">your competitors</span></h2></div>' +
      (c.state === "done" ? '<button class="btn btn-ghost btn-sm no-print" type="button" data-cmp-edit>Change competitors</button>' : "") + "</div>";
    if (!S.psi.mobile) return head + '<div class="notice">The phone test for your store didn’t finish, so there’s nothing to compare yet. Run the speed test again from the Speed tab first.</div>';
    if (c.state === "empty") {
      return head + '<form class="cp-card cp-form" data-cmp-form novalidate><div class="sp-dots" aria-hidden="true"></div><div style="display:flex;flex-direction:column;gap:8px;max-width:620px"><h3 class="h3">See where ' + esc(dom) + ' ranks</h3><p class="small" style="margin:0;font-size:15px;color:var(--text-2)">Add up to 3 competitors and see where your store ranks on the exact same phone test.</p></div>' +
        '<div class="cp-inputs">' + [0, 1, 2].map(function (i) { return '<div><label for="cmp' + i + '">Competitor ' + (i + 1) + '</label><input id="cmp' + i + '" data-cmp-in="' + i + '" type="text" inputmode="url" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="competitor' + (i + 1) + '.com" value="' + esc(c.inputs[i]) + '"></div>'; }).join("") + "</div>" +
        '<div class="cp-auto"><button class="btn btn-ghost btn-sm" type="button" data-cmp-auto' + (c.finding ? " disabled" : "") + '><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' + (c.finding ? "Finding your competitors\u2026" : "Auto-detect competitors") + "</button>" + (c.auto && !c.finding ? '<span class="small" style="font-size:13px">Picked for you. Change any of them if you like.</span>' : '<span class="small" style="font-size:13px">Too busy to type? We\u2019ll pick 3 for you.</span>') + "</div>" +
        '<p class="form-error" data-cmp-err role="alert"' + (c.err ? "" : " hidden") + ">" + esc(c.err || "") + "</p>" +
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><button class="btn btn-primary" type="submit">Compare speed <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button><span class="small" style="font-size:13px">About a minute. Your own result is already in.</span></div>' +
        '<div class="cp-get"><span class="vis-label">What you’ll get</span><div class="pills"><span class="chip">Your rank</span><span class="chip">Score, Speed Index, LCP and taps side by side</span><span class="chip">How far you are from the fastest brand</span></div></div></form>';
    }
    if (c.state === "running") {
      return head + '<div class="cp-card"><div class="sp-dots" aria-hidden="true"></div><h3 class="h3">Testing ' + c.list.length + " competitor" + (c.list.length > 1 ? "s" : "") + ' on a phone…</h3><div class="cp-run">' +
        '<div><span>' + esc(dom) + ' <small>You</small></span><b style="color:' + band(S.psi.mobile.perf) + '">' + S.psi.mobile.perf + "</b></div>" +
        c.list.map(function (x) { return "<div><span>" + esc(host(x.url)) + "</span>" + (x.pending ? '<b class="cp-spin" aria-label="testing"></b>' : x.psi ? '<b style="color:' + band(x.psi.perf) + '">' + x.psi.perf + "</b>" : '<b style="color:' + DIM + '">no answer</b>') + "</div>"; }).join("") +
        '</div><span class="small" style="font-size:13px">Google takes 30 to 90 seconds per page. Results fill in as they finish, and the wait stops at 100 seconds.</span></div>';
    }
    // done
    var rows = cmpRows(), n = rows.length, me = 0;
    rows.forEach(function (r, i) { if (r.you) me = i; });
    var best = rows[0], youP = S.psi.mobile, faster = me;
    var title = n < 2 ? "Your competitors couldn’t be tested." : me === 0 ? "You’re the fastest on a phone." : faster === 1 ? "One competitor loads faster than you on a phone." : (["", "", "Two", "Three"][faster] || faster) + " competitors load faster than you on a phone.";
    var lcpGap = best && !best.you && youP.m.lcp != null && best.psi.m.lcp != null ? youP.m.lcp - best.psi.m.lcp : null;
    var sub = n < 2 ? "Google PageSpeed didn’t answer for them. Try again in a minute." : me === 0 ? (rows[1] ? host(rows[1].url) + " is next, " + (youP.perf - rows[1].psi.perf) + " points behind you. Keep the lead." : "") :
      host(best.url) + (lcpGap != null && lcpGap > 0 ? " shows its main content " + sec(lcpGap) + " sooner." : " scores " + (best.psi.perf - youP.perf) + " points higher.") + " Close that gap and you move to #" + me + ".";
    var failed = S.cmp.list.filter(function (x) { return !x.psi; });
    var rankCard = '<div class="cp-card cp-rank"><div class="sp-dots" aria-hidden="true"></div><div class="cp-big"><b>#' + (me + 1) + "</b><span>of " + n + '</span></div><div style="flex:1 1 380px;min-width:0;display:flex;flex-direction:column;gap:10px"><h3 class="h3" style="font-size:clamp(22px,2.4vw,28px)">' + title + '</h3><p class="small" style="margin:0;font-size:15px;color:var(--text-2)">' + esc(sub) + "</p>" +
      (failed.length ? '<p class="small" style="margin:0;font-size:13px">No answer from Google for ' + failed.map(function (x) { return esc(host(x.url)); }).join(", ") + ".</p>" : "") + "</div></div>";
    var anyLab = rows.some(function (r) { return tapVal(r.psi).lab; });
    var board = '<div class="cp-board"><h3>Leaderboard · phone test</h3><div class="cp-scroll"><div class="cp-grid cp-th"><span>Brand</span><span>Performance score</span><span>Speed Index</span><span>LCP</span><span>Taps' + (anyLab ? " (INP or TBT)" : " (INP)") + "</span></div>" +
      rows.map(function (r, i) {
        var p = r.psi, tv = tapVal(p);
        return '<div class="cp-grid cp-row' + (r.you ? " you" : "") + '"><div class="cp-brand"><i>' + (i + 1) + "</i><span>" + esc(host(r.url)) + "<small>" + (r.you ? "You" : i === 0 ? "Fastest" : "Competitor") + '</small></span></div><div class="cp-score"><b style="color:' + band(p.perf) + '">' + p.perf + '</b><div><i style="width:' + p.perf + "%;background:" + band(p.perf) + '"></i></div></div><span style="color:' + mcol("si", p.m.si) + '">' + sec(p.m.si) + '</span><span style="color:' + mcol("lcp", p.m.lcp) + '">' + sec(p.m.lcp) + '</span><span style="color:' + mcol(tv.k, tv.v) + '">' + msf(tv.v) + (tv.lab ? " <small>TBT</small>" : "") + "</span></div>";
      }).join("") + "</div></div></div>";
    var gaps = "";
    if (n > 1) {
      var ref = me === 0 ? rows[1] : rows[0], sign = me === 0 ? -1 : 1, rp = ref.psi, nm = esc(host(ref.url));
      var g = function (label, a, b, fmt, more, less, tiny) {
        if (a == null || b == null) return "";
        var d = a - b; // positive = you are slower
        if (Math.abs(d) < tiny) return '<div class="cp-gap"><span class="vis-label">' + label + " vs " + nm + '</span><b style="color:' + A + '">Level</b><span>About the same as ' + nm + ".</span></div>";
        return '<div class="cp-gap"><span class="vis-label">' + label + " vs " + nm + '</span><b style="color:' + (d > 0 ? R : G) + '">' + (d > 0 ? "+" : "\u2212") + fmt(Math.abs(d)) + "</b><span>" + (d > 0 ? more : less) + "</span></div>";
      };
      var ty = tapVal(youP), tr = tapVal(rp);
      gaps = '<div class="cp-gaps">' +
        g("Speed Index", youP.m.si, rp.m.si, sec, "Your page takes longer to fill in.", "Your page fills in sooner.", 50) +
        g("LCP", youP.m.lcp, rp.m.lcp, sec, "Your main product shows later.", "Your main product shows sooner.", 50) +
        (ty.k === tr.k ? g(ty.k === "inp" ? "INP" : "Blocked time", ty.v, tr.v, msf, "Taps on your page respond slower.", "Taps on your page respond faster.", 5) : "") + "</div>";
    }
    return head + rankCard + board + gaps;
  }
  function compareSection() { return '<section class="rep-sec" id="compare"><div class="wrap" id="cmpWrap">' + compareInner() + "</div></section>"; }
  function renderCompare() { var w = $("#cmpWrap"); if (w) w.innerHTML = compareInner(); }
  function startCompare() {
    var mine = host(URL0), seen = {}, bad = [];
    var urls = S.cmp.inputs.map(function (v) { var c = clean(v); if (String(v || "").trim() && !c) bad.push(v); return c; }).filter(function (u) { var h = u && host(u); if (!u || h === mine || seen[h]) return false; seen[h] = 1; return true; });
    if (bad.length) { S.cmp.err = "Check this address: " + bad[0]; renderCompare(); return; }
    if (!urls.length) { S.cmp.err = "Add at least one competitor, e.g. competitor.com"; renderCompare(); var f = $("#cmp0"); if (f) f.focus(); return; }
    S.cmp.err = ""; S.cmp.state = "running";
    S.cmp.list = urls.map(function (u) { var pre = S.comps.filter(function (x) { return x.url === u && x.psi; })[0]; return { url: u, psi: pre ? pre.psi : null, pending: !pre }; });
    renderCompare();
    try { var q = new URLSearchParams(location.search); q.set("vs", urls.map(shortUrl).join(",")); history.replaceState(null, "", "?" + q.toString()); } catch (e) {}
    Promise.all(S.cmp.list.map(function (x) {
      if (!x.pending) return Promise.resolve();
      return Promise.race([runPsiOnce(x.url, "mobile"), new Promise(function (_, no) { setTimeout(function () { no(new Error("timeout")); }, 100000); })]).then(function (m) { x.psi = m; }).catch(function () { x.psi = null; }).then(function () { x.pending = false; if (S.cmp.state === "running") renderCompare(); });
    })).then(function () { S.cmp.state = "done"; renderCompare(); var rec = mailRec(); if (rec) scheduleReportEmail(rec.to, rec.name); });
  }
  function autoDetect() {
    if (!CFG.reportApi || S.cmp.finding) return;
    var h = (S.scan && S.scan.html) || {};
    S.cmp.finding = true; S.cmp.err = ""; renderCompare();
    timeoutFetch(CFG.reportApi + "/competitors", { method: "POST", headers: { authorization: "Bearer " + CFG.anonKey, apikey: CFG.anonKey, "content-type": "application/json" }, body: JSON.stringify({ url: URL0, title: h.title || "", desc: h.desc || "", h1: h.h1 || "", platform: (S.scan && S.scan.platform) || "", price: (h.jsonld && h.jsonld.product && h.jsonld.product.price ? (h.jsonld.product.currency || "") + " " + h.jsonld.product.price : h.price || ""), text: String(h.agentText || "").slice(0, 900) }) }, 35000)
      .then(function (r) { return r.json(); })
      .then(function (d) { var list = (d && d.competitors) || []; if (!list.length) throw new Error("none"); S.cmp.inputs = list.concat(["", "", ""]).slice(0, 3); S.cmp.auto = true; })
      .catch(function () { S.cmp.err = "Couldn\u2019t find competitors automatically. Add them yourself."; })
      .then(function () { S.cmp.finding = false; renderCompare(); });
  }

  function compsSection() {
    if (!S.comps.length) return "";
    var cols = [{ url: URL0, psi: S.psi.mobile, scan: S.scan, you: true }].concat(S.comps);
    var cell = function (v, color) { return v == null ? '<span style="color:' + DIM + '">—</span>' : '<span style="color:' + (color || "#F4F3F8") + '">' + esc(v) + "</span>"; };
    var rows = [
      ["Mobile speed score", function (c) { return c.psi ? cell(c.psi.perf, band(c.psi.perf)) : cell(null); }],
      ["Main content on a phone (lab)", function (c) { return c.psi ? cell(sec(c.psi.m.lcp), mcol("lcp", c.psi.m.lcp)) : cell(null); }],
      ["Real shoppers see content in", function (c) { return c.psi && c.psi.field && c.psi.field.lcp ? cell(sec(c.psi.field.lcp), mcol("lcp", c.psi.field.lcp)) : cell(null); }],
      ["Third-party scripts (phone CPU)", function (c) { return c.psi ? cell(msf(c.psi.third.reduce(function (s, x) { return s + x.main; }, 0))) : cell(null); }],
      ["Search score", function (c) { return c.scan ? cell(c.scan.search.score, band(c.scan.search.score)) : cell(null); }],
      ["AI answers score", function (c) { return c.scan ? cell(c.scan.ai.score, band(c.scan.ai.score)) : cell(null); }],
      ["ChatGPT search crawler", function (c) { if (!c.scan) return cell(null); var b = c.scan.robots.bots.filter(function (x) { return x.ua === "OAI-SearchBot"; })[0]; return cell(b.allowed ? "allowed" : "blocked", b.allowed ? G : R); }],
      ["Product schema", function (c) { if (!c.scan || !c.scan.html) return cell(null); var p = c.scan.html.jsonld.product; return cell(p ? (p.rating ? "full, with ratings" : "no ratings") : "missing", p ? (p.rating ? G : A) : R); }],
      ["llms.txt", function (c) { return c.scan ? cell(c.scan.llms.found ? "found" : "missing", c.scan.llms.found ? G : A) : cell(null); }]
    ];
    return '<section class="rep-sec"><div class="wrap"><div class="rep-sec-head"><h2 class="h2">You vs <span class="hl">your competitors</span></h2><span class="small">Same tests, same moment, on a phone</span></div><div class="cmp"><table><thead><tr><th scope="col" style="width:26%"><span class="small">Check</span></th>' +
      cols.map(function (c) { return '<th scope="col" class="' + (c.you ? "you" : "") + '">' + esc(host(c.url)) + "<small>" + (c.you ? "You" : "Competitor") + "</small></th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return '<tr><th scope="row">' + r[0] + "</th>" + cols.map(function (c) { return '<td class="' + (c.you ? "you" : "") + '">' + r[1](c) + "</td>"; }).join("") + "</tr>"; }).join("") +
      "</tbody></table></div></div></section>";
  }

  function fixList() {
    var items = [], m = S.psi.mobile, d = S.scan;
    if (m) m.causes.forEach(function (c) { var im = impactOf(c); items.push({ w: Math.min(6, c.sav / 1000 * 2 + c.tbt / 1000) + (c.status === "fail" ? 1 : 0), tag: "Performance", title: c.title, why: c.plain, imp: im[0] }); });
    var boost = { status: 6, firewall: 5, "OAI-SearchBot": 4.5, rawprice: 3.6, schema: 3.4, PerplexityBot: 3.2, rawtext: 3.2, offer: 3, googlebot: 6 };
    if (d) {
      d.search.checks.forEach(function (c) { if (c.status !== "pass") items.push({ w: (boost[c.id] || (c.status === "fail" ? 2.5 : 1)), tag: "Search", title: c.title, why: c.why }); });
      d.ai.checks.forEach(function (c) { if (c.status !== "pass") items.push({ w: (boost[c.id] || (c.status === "fail" ? 2.6 : c.id === "llms" ? 1.4 : 1)), tag: "AI answers", title: c.title, why: c.why }); });
    }
    items.sort(function (a, b) { return b.w - a.w; });
    var top = items.slice(0, 5);
    if (!top.length) return "";
    return '<section class="rep-sec"><div class="wrap"><div class="rep-sec-head"><h2 class="h2">Fix these <span class="hl">first</span></h2><span class="small">Biggest impact for the least effort, across all three</span></div><div class="fixes">' +
      top.map(function (x, i) { return '<div class="fix"><span class="no">0' + (i + 1) + '</span><div><b>' + esc(x.title) + "</b><span>" + esc(x.why) + (x.imp ? " · " + esc(x.imp) : "") + '</span></div><span class="tg">' + x.tag + "</span></div>"; }).join("") + "</div></div></section>";
  }

  // ---------- branded report (PDF download + report email), drawn by assets/js/report-doc.js ----------
  function kindOfC(c) { return c === G ? "ok" : c === A ? "warn" : c === R ? "bad" : ""; }
  function reportData() {
    var m = S.psi.mobile, dsk = S.psi.desktop, d = S.scan, f = m && m.field, dom = host(URL0), vit = [];
    if (m) {
      var lcpV = f && f.lcp != null ? f.lcp : m.m.lcp, clsV = f && f.cls != null ? f.cls : m.m.cls;
      if (lcpV != null) vit.push({ name: "Main content shows", abbr: "LCP" + (f && f.lcp != null ? " \u00b7 real shoppers" : " \u00b7 lab"), value: sec(lcpV), good: "\u2264 2.5 s", kind: kindOfC(mcol("lcp", lcpV)) });
      if (f && f.inp != null) vit.push({ name: "Taps respond", abbr: "INP \u00b7 real shoppers", value: msf(f.inp), good: "\u2264 200 ms", kind: kindOfC(mcol("inp", f.inp)) });
      else if (m.m.tbt != null) vit.push({ name: "Page blocked from taps", abbr: "TBT \u00b7 lab", value: msf(m.m.tbt), good: "\u2264 200 ms", kind: kindOfC(mcol("tbt", m.m.tbt)) });
      if (clsV != null) vit.push({ name: "Layout jumps", abbr: "CLS", value: clsV.toFixed(2), good: "\u2264 0.10", kind: kindOfC(mcol("cls", clsV)) });
      if (m.m.si != null) vit.push({ name: "Page fills in", abbr: "Speed Index", value: sec(m.m.si), good: "\u2264 3.4 s", kind: kindOfC(mcol("si", m.m.si)) });
      if (m.m.fcp != null) vit.push({ name: "First paint", abbr: "FCP", value: sec(m.m.fcp), good: "\u2264 1.8 s", kind: kindOfC(mcol("fcp", m.m.fcp)) });
    }
    var up = m && m.perf != null ? uplift(m.perf, dom) : null;
    var chk = function (c) { return { status: c.status, title: c.title, why: c.why }; };
    return {
      site: dom, date: new Date(S.saved ? S.saved.at : Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }), platform: (d && d.platform) || "",
      scores: { perf: m ? m.perf : null, desk: dsk ? dsk.perf : null, search: d ? d.search.score : null, ai: d ? d.ai.score : null, searchN: d ? d.search.checks.length : null, aiN: d ? d.ai.checks.length : null },
      uplift: up ? { target: up.target, conv: up.conv, rev: up.rev } : null,
      cwv: f ? (f.lcp != null && f.lcp <= 2500 && (f.inp == null || f.inp <= 200) && (f.cls == null || f.cls <= 0.1)) : null,
      vitals: vit,
      fixes: planItems().map(function (x) { return { tag: x.tag, title: x.title, why: x.why, imp: x.imp, effort: x.effort, who: x.who }; }),
      search: d ? d.search.checks.map(chk) : [], ai: d ? d.ai.checks.map(chk) : [],
      bots: d ? d.robots.bots.filter(function (b) { return !b.allowed && b.ua !== "Googlebot" && b.ua !== "Bingbot"; }).map(function (b) { return b.ua; }) : [],
      apps: m ? m.third.filter(function (x) { return x.cost >= 1; }).slice(0, 5).map(function (x) { return { name: x.name, ms: x.cost }; }) : [],
      comps: S.cmp && S.cmp.state === "done" ? cmpRows().map(function (r) { return { site: host(r.url), perf: r.psi.perf, si: sec(r.psi.m.si), lcp: sec(r.psi.m.lcp), you: !!r.you }; }) : [],
      reportUrl: location.origin + location.pathname.replace(/[^/]*$/, "") + "audit.html?url=" + encodeURIComponent(shortUrl(URL0)) + (S.snapId ? "&r=" + S.snapId : ""), demoUrl: CFG.calendly,
      // for picking competitors at send time, when the visitor didn't run the comparison
      ctx: d && d.html ? { title: d.html.title || "", desc: d.html.desc || "", h1: d.html.h1 || "", price: d.html.jsonld && d.html.jsonld.product && d.html.jsonld.product.price ? (d.html.jsonld.product.currency || "") + " " + d.html.jsonld.product.price : d.html.price || "", text: String(d.html.agentText || "").slice(0, 900), platform: d.platform || "" } : null,
      lab: m ? { si: m.m.si, lcp: m.m.lcp } : null
    };
  }
  // PDF: the branded report in its own window, then the browser's Save as PDF
  function downloadPdf() {
    if (!win.TPReportDoc) { win.print(); return; }
    var html = win.TPReportDoc.render(reportData(), { mode: "print", assetBase: new URL(".", location.href).href });
    var w = null; try { w = win.open("", "_blank"); } catch (e) { w = null; }
    var target, cleanup = function () {};
    if (w) { target = w; }
    else { var fr = doc.createElement("iframe"); fr.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0"; doc.body.appendChild(fr); target = fr.contentWindow; cleanup = function () { setTimeout(function () { fr.remove(); }, 60000); }; }
    target.document.open(); target.document.write(html); target.document.close();
    var imgs = Array.prototype.slice.call(target.document.images);
    Promise.race([Promise.all(imgs.map(function (im) { return im.complete ? 1 : new Promise(function (r) { im.onload = im.onerror = r; }); })), new Promise(function (r) { setTimeout(r, 3500); })])
      .then(function () { return new Promise(function (r) { setTimeout(r, 400); }); })
      .then(function () { try { target.focus(); target.print(); } catch (e) {} cleanup(); });
  }
  // Report email: queued on the server at unlock (one pending entry per email + store). A competitor test updates it.
  // Nothing is sent from here: the queue is reviewed and approved twice a day (12 PM, 6 PM IST), then sent.
  win.TPReport = { data: reportData, pdf: downloadPdf, save: function () { return saveSnap().then(function () { return S.snapId; }); } };
  var MAIL_KEY = "tp_mail";
  function mailRec() { try { return (JSON.parse(localStorage.getItem(MAIL_KEY) || "{}") || {})[host(URL0)] || null; } catch (e) { return null; } }
  function saveMail(r) { try { var all = JSON.parse(localStorage.getItem(MAIL_KEY) || "{}") || {}; all[host(URL0)] = r; localStorage.setItem(MAIL_KEY, JSON.stringify(all)); } catch (e) {} }
  function scheduleReportEmail(to, name) {
    if (!CFG.reportApi || !to || !win.fetch) return;
    saveSnap().then(function () {
    var body = { to: to, name: name || "", data: reportData() };
    timeoutFetch(CFG.reportApi + "/email", { method: "POST", headers: { authorization: "Bearer " + CFG.anonKey, apikey: CFG.anonKey, "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }, 20000)
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.id) saveMail({ id: d.id, to: to, name: name || "", at: Date.now() }); })
      .catch(function () {});
    });
  }

  // ---------- full report (fix plan + competitor rank), unlocked with a short form ----------
  var LOCK_KEY = "tp_unlocked";
  S.unlocked = false;
  try { S.unlocked = (JSON.parse(localStorage.getItem(LOCK_KEY) || "[]") || []).indexOf(host(URL0)) >= 0; } catch (e) {}
  var EFFORT = { llms: "Quick win", "OAI-SearchBot": "Quick win", GPTBot: "Quick win", PerplexityBot: "Quick win", ClaudeBot: "Quick win", sitemap: "Quick win", canonical: "Quick win", title: "Quick win", desc: "Quick win", noindex: "Quick win", alt: "Quick win", firewall: "Hosting setting", status: "Urgent", schema: "Developer task", offer: "Developer task", rawprice: "Developer task", rawtext: "Developer task", faq: "Content", googlebot: "Urgent" };
  function planItems() {
    var items = [], m = S.psi.mobile, d = S.scan;
    if (m) m.causes.forEach(function (c) { var im = impactOf(c); items.push({ w: Math.min(6, c.sav / 1000 * 2 + c.tbt / 1000) + (c.status === "fail" ? 1 : 0), tag: "Performance", title: c.title, why: c.plain, imp: im[0], impColor: im[1], who: c.who, effort: c.sav >= 1500 || c.tbt >= 600 ? "Big win" : "Developer task", sav: c.sav }); });
    var boost = { status: 6, firewall: 5, "OAI-SearchBot": 4.5, rawprice: 3.6, schema: 3.4, PerplexityBot: 3.2, rawtext: 3.2, offer: 3, googlebot: 6 };
    if (d) {
      d.search.checks.forEach(function (c) { if (c.status !== "pass") items.push({ w: (boost[c.id] || (c.status === "fail" ? 2.5 : 1)), tag: "Search", title: c.title, why: c.why, imp: c.status === "fail" ? "Google sees less of you" : "Small lift", impColor: c.status === "fail" ? R : A, who: "Developer / SEO", effort: EFFORT[c.id] || (c.status === "fail" ? "Developer task" : "Quick win") }); });
      d.ai.checks.forEach(function (c) { if (c.status !== "pass") items.push({ w: (boost[c.id] || (c.status === "fail" ? 2.6 : c.id === "llms" ? 1.4 : 1)), tag: "AI answers", title: c.title, why: c.why, imp: c.status === "fail" ? "AI can’t recommend you" : "Small lift", impColor: c.status === "fail" ? R : A, who: "Developer / content", effort: EFFORT[c.id] || (c.status === "fail" ? "Developer task" : "Quick win") }); });
    }
    items.sort(function (a, b) { return b.w - a.w; });
    return items.slice(0, 6);
  }
  function planSummary(items) {
    var secs = items.reduce(function (s, x) { return s + (x.sav || 0); }, 0), quick = items.filter(function (x) { return x.effort === "Quick win"; }).length;
    return { n: items.length, secs: secs, quick: quick };
  }
  function planHtml(items) {
    var sm = planSummary(items);
    return '<div class="fp"><div class="fp-sum"><div><b>' + sm.n + '</b><span>fixes, ranked by impact</span></div>' + (sm.secs >= 300 ? '<div><b>−' + (sm.secs / 1000).toFixed(1) + ' s</b><span>faster on a phone, Google’s estimate</span></div>' : "") + (sm.quick ? '<div><b>' + sm.quick + '</b><span>quick wins you can do this week</span></div>' : '<div><b>' + items.filter(function (x) { return x.tag !== "Performance"; }).length + '</b><span>search and AI fixes</span></div>') + "</div>" +
      '<ol class="fp-list">' + items.map(function (x, i) {
        return '<li class="fp-item"><span class="fp-no">' + (i + 1 < 10 ? "0" : "") + (i + 1) + '</span><div class="fp-body"><div class="fp-top"><span class="fp-tag t-' + x.tag.replace(/\s.*/, "").toLowerCase() + '">' + x.tag + '</span><span class="fp-eff">' + esc(x.effort) + "</span></div><b>" + esc(x.title) + "</b><span>" + esc(x.why) + '</span><div class="fp-meta"><span>Impact <em style="color:' + (x.impColor || DIM) + '">' + esc(x.imp || "minor") + "</em></span><span>Who fixes it <em>" + esc(x.who || "Developer") + "</em></span></div></div></li>";
      }).join("") + "</ol></div>";
  }
  function lockedHtml(items) {
    var sm = planSummary(items), dom = host(URL0);
    var teaserRows = items.slice(0, 4).map(function (x, i) { return '<li class="fp-item"><span class="fp-no">0' + (i + 1) + '</span><div class="fp-body"><div class="fp-top"><span class="fp-tag">' + x.tag + '</span><span class="fp-eff">' + esc(x.effort) + "</span></div><b>" + esc(x.title) + "</b><span>" + esc(x.why) + "</span></div></li>"; }).join("");
    var fakeBoard = [78, 61, 54, 42].map(function (v, i) { return '<div class="lk-row"><i>' + (i + 1) + '</i><span class="lk-name"></span><div><b style="width:' + v + '%"></b></div><span class="lk-num">' + v + "</span></div>"; }).join("");
    return '<div class="lk"><div class="lk-grid" aria-hidden="true">' +
      '<div class="lk-card"><h3 class="h3">Fix these first</h3><span class="small">' + sm.n + " fixes for " + esc(dom) + (sm.secs >= 300 ? ", about " + (sm.secs / 1000).toFixed(1) + " s faster" : "") + '</span><ol class="fp-list lk-blur">' + teaserRows + "</ol></div>" +
      '<div class="lk-card"><h3 class="h3">Where you rank</h3><span class="small">You vs up to 3 competitors, same phone test</span><div class="lk-blur lk-board">' + fakeBoard + "</div></div></div>" +
      '<form class="lk-form" data-lead-form novalidate><div class="lk-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>' +
      '<h3>Unlock your full report</h3><p>Your ' + sm.n + '-step fix plan, ranked by impact, plus your rank against up to 3 competitors.</p>' +
      '<div class="lk-fields">' +
      '<div class="lk-f"><label for="ldName">Your name</label><input id="ldName" name="name" autocomplete="name" placeholder="Jamie Carter"><span class="lk-e" data-e="name"></span></div>' +
      '<div class="lk-f"><label for="ldEmail">Work email</label><input id="ldEmail" name="email" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" placeholder="jamie@yourbrand.com" aria-describedby="ldHint"><span class="lk-hint" id="ldHint" aria-live="polite"></span><span class="lk-e" data-e="email"></span></div>' +
      '<div class="lk-f"><label for="ldPhone">Phone <small>(WhatsApp or text)</small></label><div class="lk-phone"><select name="cc" aria-label="Country code">' + CCS.map(function (c) { return '<option value="' + c[1] + '"' + (c[0] === defaultCC() ? " selected" : "") + ">" + c[0] + (c[1] === "other" ? "" : " " + c[1]) + "</option>"; }).join("") + '</select><input id="ldPhone" name="phone" type="tel" autocomplete="tel-national" inputmode="tel" placeholder="' + (defaultCC() === "IN" ? "98765 43210" : "(415) 555 0132") + '"></div><span class="lk-e" data-e="phone"></span></div>' +
      '<div class="lk-f"><label for="ldSite">Store website</label><input id="ldSite" name="website" autocapitalize="none" spellcheck="false" value="' + esc(dom) + '" placeholder="yourbrand.com"><span class="lk-e" data-e="website"></span></div>' +
      '<div class="lk-f"><label for="ldOrders">Monthly orders</label><select id="ldOrders" name="orders"><option value="" selected disabled>Pick a range</option>' + ["Under 500", "500 to 2,000", "2,000 to 10,000", "10,000 to 25,000", "25,000 to 50,000", "50,000+"].map(function (o) { return "<option>" + o + "</option>"; }).join("") + '</select><span class="lk-e" data-e="orders"></span></div>' +
      '<div class="lk-f"><label for="ldHeard">How did you find TrooPerformance?</label><select id="ldHeard" name="heard_from"><option value="" selected>Pick one</option>' + ["Instagram", "Facebook", "LinkedIn", "Google", "Other"].map(function (o) { return "<option>" + o + "</option>"; }).join("") + '</select></div>' +
      '<input type="text" name="company_site" tabindex="-1" autocomplete="off" aria-hidden="true" class="lk-hp">' +
      '</div><p class="form-error" data-lead-err role="alert" hidden></p><button class="btn btn-primary lk-btn" type="submit">Unlock full report <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>' +
      '<span class="lk-note">Free. Work email only. No spam, ever.</span></form></div>';
  }
  function fullSection() {
    var items = planItems();
    var head = '<div class="rep-sec-head"><div style="display:flex;flex-direction:column;gap:10px"><span class="eyebrow">Your full report</span><h2 class="h2">Your fix plan <span class="hl">and where you rank</span></h2></div>' + (S.unlocked ? '<span class="lk-ok">Unlocked</span>' : "") + "</div>";
    if (!S.unlocked) return '<section class="rep-sec" id="full"><div class="wrap">' + head + lockedHtml(items) + "</div></section>";
    return '<section class="rep-sec" id="full"><div class="wrap">' + head + (items.length ? '<h3 class="h3" style="margin:0 0 14px">Fix these first</h3>' + planHtml(items) : "") + '</div></section>' + compareSection() + compsSection();
  }
  var FREE_MAIL = ["gmail.com","googlemail.com","yahoo.com","yahoo.co.in","yahoo.in","yahoo.co.uk","ymail.com","rocketmail.com","outlook.com","outlook.in","hotmail.com","hotmail.co.in","hotmail.co.uk","live.com","live.in","msn.com","icloud.com","me.com","mac.com","aol.com","rediffmail.com","rediff.com","proton.me","protonmail.com","pm.me","tutanota.com","tuta.io","zoho.com","zohomail.com","zohomail.in","yandex.com","yandex.ru","gmx.com","gmx.net","gmx.de","mail.com","email.com","inbox.com","hey.com","fastmail.com","hushmail.com","mail.ru","web.de","qq.com","163.com","126.com","sina.com","naver.com","duck.com","mailinator.com","guerrillamail.com","guerrillamail.info","sharklasers.com","grr.la","10minutemail.com","10minutemail.net","temp-mail.org","tempmail.com","tempmail.net","tempmailo.com","yopmail.com","yopmail.net","trashmail.com","getnada.com","nada.email","dispostable.com","maildrop.cc","mintemail.com","throwawaymail.com","fakeinbox.com","emailondeck.com","mohmal.com","moakt.com","tempr.email","spamgourmet.com","mailnesia.com","mytemp.email","burnermail.io","inboxkitten.com","mailpoof.com","tmail.ws","tmpmail.org"];
  function personalMail(email) { var d = String(email).toLowerCase().split("@")[1] || ""; return FREE_MAIL.some(function (x) { return d === x || d.slice(-(x.length + 1)) === "." + x; }); }
  var LEAD_ERR = { bad_email: "That email doesn\u2019t look right.", personal_email: "Please use your work email, like you@yourbrand.com. Gmail, Yahoo, Outlook and other personal inboxes aren\u2019t accepted.", no_mail_domain: "That email\u2019s domain can\u2019t receive mail. Check the spelling of the part after @." };
  function emailHint(input) {
    var hint = $("#ldHint"); if (!hint) return;
    var v = input.value.trim().toLowerCase(), d = v.split("@")[1] || "", site = host(URL0).replace(/^www\./, "");
    if (!d || d.indexOf(".") < 0) { hint.textContent = ""; hint.className = "lk-hint"; return; }
    if (personalMail(v)) { hint.textContent = "Personal inboxes aren\u2019t accepted. Use your work email."; hint.className = "lk-hint bad"; return; }
    if (d === site || d.slice(-(site.length + 1)) === "." + site || site.slice(-(d.length + 1)) === "." + d) { hint.textContent = "\u2713 Matches " + site; hint.className = "lk-hint ok"; return; }
    hint.textContent = "\u2713 Work email"; hint.className = "lk-hint ok";
  }
  var CCS = [["IN", "+91"], ["US", "+1"], ["CA", "+1"], ["UK", "+44"], ["AU", "+61"], ["AE", "+971"], ["Other", "other"]];
  var PH_LEN = { "+1": [10, 10], "+44": [10, 10], "+61": [9, 9], "+971": [9, 9], "+91": [10, 10] };
  function defaultCC() { var tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) {} return /Calcutta|Kolkata/.test(tz) ? "IN" : /^Europe\/London/.test(tz) ? "UK" : /^Australia\//.test(tz) ? "AU" : /Dubai/.test(tz) ? "AE" : /^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax)/.test(tz) ? "CA" : /^America\//.test(tz) ? "US" : "IN"; }
  var TYPOS = { "gmial.com": "gmail.com", "gmai.com": "gmail.com", "gamil.com": "gmail.com" };
  function attribution() {
    var q = new URLSearchParams(location.search), out = {}, land = {};
    try { land = JSON.parse(sessionStorage.getItem("tp_attr") || "{}") || {}; } catch (e) {}
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"].forEach(function (k) { out[k] = q.get(k) || land[k] || ""; });
    out.referrer = land.referrer || doc.referrer || ""; out.landing_url = land.landing_url || location.href;
    return out;
  }
  function leadRules(form) {
    var el = function (n) { return form.querySelector('[name="' + n + '"]'); };
    var ph = function () { var cc = el("cc").value, d = el("phone").value.replace(/\D/g, ""); if (cc === "+1" && d.length === 11 && d[0] === "1") d = d.slice(1); if (cc !== "+1" && cc !== "other" && d[0] === "0") d = d.slice(1); return d; };
    return {
      digits: ph,
      name: function () { var v = el("name").value.trim(); if (!v) return "Add your name."; if (v.replace(/[^a-z\u00C0-\u024F]/gi, "").length < 2) return "Please enter your name."; if (/[0-9@#$%^&*()_+=<>{}\[\]\\/|~`!?;:]/.test(v)) return "Names only have letters."; return ""; },
      email: function () { var v = el("email").value.trim().toLowerCase(), d = v.split("@")[1] || ""; if (!v) return "Add your work email."; if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(v) || /\.\.|^\.|\.@|@-/.test(v)) return "That email looks a bit off. Like jamie@yourbrand.com"; if (TYPOS[d] || personalMail(v)) return LEAD_ERR.personal_email; return ""; },
      phone: function () { var cc = el("cc").value, raw = el("phone").value, d = ph(), L = PH_LEN[cc]; if (!raw.replace(/\D/g, "")) return "Add a number you can be reached on."; if (cc === "other") return /^\+?\d[\d\s().-]{6,18}$/.test(raw.trim()) ? "" : "Add your country code, like +49 30 1234567"; if (d.length < L[0] || d.length > L[1]) return "That number should have " + L[0] + " digits. This one has " + d.length + "."; if (/^(\d)\1+$/.test(d)) return "Please enter a real number."; return ""; },
      website: function () { var v = el("website").value.trim(); if (!v) return "Add your store website."; if (/@/.test(v)) return "That looks like an email. Add your store website, like yourbrand.com"; return clean(v) ? "" : "That doesn\u2019t look like a website. Like yourbrand.com"; },
      orders: function () { return el("orders").value ? "" : "Pick a range, a rough guess is fine."; }
    };
  }
  function fieldCheck(form, rules, n) {
    var msg = rules[n](), box = form.querySelector('[data-e="' + n + '"]'), input = form.querySelector('[name="' + n + '"]');
    if (box) box.textContent = msg; if (input) input.setAttribute("aria-invalid", msg ? "true" : "false");
    var wrap = input && input.closest(".lk-f"); if (wrap) wrap.classList.toggle("bad", !!msg);
    return !msg;
  }
  function submitLead(form) {
    var rules = leadRules(form), err = form.querySelector("[data-lead-err]"), btn = form.querySelector("button[type=submit]");
    var g = function (n) { return (form.querySelector('[name="' + n + '"]') || {}).value || ""; };
    var bad = ["name", "email", "phone", "website", "orders"].filter(function (n) { return !fieldCheck(form, rules, n); });
    if (bad.length) { var f = form.querySelector('[name="' + (bad[0] === "phone" ? "phone" : bad[0]) + '"]'); if (f) f.focus(); return; }
    var comps = g("comp").split(/[,\s]+/).map(clean).filter(Boolean).slice(0, 3);
    var cc = g("cc"), ccLabel = form.querySelector('[name="cc"]').selectedOptions[0].textContent.slice(0, 2);
    var phone = cc === "other" ? g("phone").trim().replace(/[^\d+]/g, "").replace(/^(?!\+)/, "+") : cc + rules.digits();
    var site = g("website").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
    err.hidden = true; btn.disabled = true; btn.firstChild.textContent = "Unlocking\u2026 ";
    var at = attribution();
    var body = Object.assign({ name: g("name").trim(), email: g("email").trim().toLowerCase(), phone: phone, country_code: cc === "other" ? "" : cc + (cc === "+1" ? " " + ccLabel : ""), site: site, orders: g("orders"), heard_from: g("heard_from"), competitors: comps.map(shortUrl), speed: S.psi.mobile ? S.psi.mobile.perf : null, search: S.scan ? S.scan.search.score : null, ai: S.scan ? S.scan.ai.score : null, report: location.href }, at);
    var reset = function () { btn.disabled = false; btn.firstChild.textContent = "Unlock full report "; };
    // One id for the browser Lead (Meta Pixel) and the sheet row, so Meta can dedupe it against the server-side Lead.
    var leadId = "tp-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    var done = function () {
      if (!g("company_site")) {
        track("generate_lead", { lead_source: "trooperformance" }); // GTM -> GA4 generate_lead + Reddit Lead
        fb("Lead", { content_name: "TrooPerformance report" }, leadId);
      }
      // Google Sheet (TrooFestive Data > "TrooPerformance leads") + email alert, via the Troopod Apps Script. Doesn't block the unlock.
      if (CFG.sheetEndpoint && !g("company_site")) {
        var row = Object.assign({ source: "trooperformance", name: body.name, email: body.email, phone: body.phone, country_code: body.country_code, website: site, orders: body.orders, heard_from: body.heard_from, competitors: body.competitors.join(", "), speed_score: body.speed, search_score: body.search, ai_score: body.ai, report_url: body.report, page: location.href.split("#")[0], submitted_at: new Date().toISOString(), event_id: leadId, user_agent: navigator.userAgent }, at, metaIds());
        try { fetch(CFG.sheetEndpoint, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(row), keepalive: true }).catch(function () {}); } catch (e) {}
      }
      S.unlocked = true;
      if (!g("company_site")) scheduleReportEmail(body.email, body.name);
      try { var l = JSON.parse(localStorage.getItem(LOCK_KEY) || "[]") || []; l.push(host(URL0)); localStorage.setItem(LOCK_KEY, JSON.stringify(l.slice(-20))); } catch (e) {}
      if (comps.length) S.cmp.inputs = comps.map(shortUrl).concat(["", "", ""]).slice(0, 3);
      var sec = $("#full"); if (sec) { var tmp = doc.createElement("div"); tmp.innerHTML = fullSection(); sec.replaceWith.apply(sec, Array.prototype.slice.call(tmp.children)); }
      var nf = $("#full"); if (nf) nf.scrollIntoView({ behavior: "smooth", block: "start" });
      if (comps.length && S.psi.mobile) startCompare();
    };
    if (g("company_site")) { done(); return; } // bots fill the hidden field: show the report, save nothing
    var url = (CFG.leadApi || (CFG.api || "").replace(/trooperformance-audit\/?$/, "trooperformance-lead"));
    timeoutFetch(url, { method: "POST", headers: { authorization: "Bearer " + CFG.anonKey, apikey: CFG.anonKey, "content-type": "application/json" }, body: JSON.stringify(body) }, 15000)
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (r.status === 400 && LEAD_ERR[d.error]) throw new Error(d.error); }); })
      .then(done, function (e) {
        var code = e && e.message;
        if (LEAD_ERR[code]) { var box = form.querySelector('[data-e="email"]'); if (box) box.textContent = LEAD_ERR[code]; var em = form.querySelector('[name="email"]'); if (em) { em.setAttribute("aria-invalid", "true"); em.closest(".lk-f").classList.add("bad"); em.focus(); } reset(); return; }
        done(); // network trouble: don't make the visitor pay for it
      });
  }
  function tabCount(id) {
    if (id === "speed") { var m = S.psi[S.device]; return m ? m.causes.filter(function (c) { return c.status === "fail"; }).length : 0; }
    var d = S.scan; if (!d) return 0;
    return (id === "search" ? d.search : d.ai).checks.filter(function (c) { return c.status === "fail"; }).length;
  }
  function tabsHtml() {
    return [["speed", "Performance"], ["search", "Search"], ["ai", "AI answers"]].map(function (t) { var n = tabCount(t[0]); return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + (n ? '<span class="cnt">' + n + "</span>" : "") + "</button>"; }).join("");
  }
  function panelHtml() { return S.tab === "speed" ? speedPanel() : S.tab === "search" ? searchPanel() : aiPanel(); }

  function renderReport() {
    var hl = headline(), m = S.psi.mobile, dsk = S.psi.desktop, d = S.scan;
    var date = new Date(S.saved ? S.saved.at : Date.now()).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    return '<section class="rep-hero"><div class="dots" aria-hidden="true"></div><div class="glow2" aria-hidden="true"></div><div class="wrap"><div class="txt">' +
      '<div class="tagrow"><span class="eyebrow">Report · ' + esc(host(URL0)) + " · " + esc(date) + "</span>" + (d && d.platform ? '<span class="badge">' + esc(d.platform) + "</span>" : "") + "</div>" +
      '<h1 class="h1">' + hl.h + '</h1><p class="lead" style="max-width:580px">' + esc(hl.l) + '</p><div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" type="button" data-copy>Copy link</button><button class="btn btn-ghost btn-sm" type="button" data-print>Download PDF</button>' + (S.saved ? '<a class="btn btn-ghost btn-sm" href="audit.html?url=' + encodeURIComponent(shortUrl(URL0)) + '">Run a fresh scan</a>' : "") + "</div></div>" +
      '<div class="scores">' +
      '<div class="score">' + ring(m ? m.perf : null, 92, 9) + "<b>Performance</b><span style=\"color:" + band(m && m.perf) + '">' + (m ? bandName(m.perf) : "No data") + '</span><span class="sub2">' + (dsk ? "desktop " + dsk.perf : S.pendingDesktop ? "desktop…" : "mobile") + "</span></div>" +
      '<div class="score">' + ring(d ? d.search.score : null, 92, 9) + "<b>Search</b><span style=\"color:" + band(d && d.search.score) + '">' + (d ? bandName(d.search.score) : "No data") + '</span><span class="sub2">' + (d ? d.search.checks.length + " checks" : "") + "</span></div>" +
      '<div class="score">' + ring(d ? d.ai.score : null, 92, 9) + "<b>AI answers</b><span style=\"color:" + band(d && d.ai.score) + '">' + (d ? bandName(d.ai.score) : "No data") + '</span><span class="sub2">' + (d ? d.ai.checks.length + " checks" : "") + "</span></div>" +
      "</div></div></section>" +
      '<section class="rep-sec"><div class="wrap"><div class="rep-sec-head"><h2 class="h2">What\u2019s holding your store back</h2><div class="tabs no-print" role="tablist" aria-label="Report area" id="tabs">' + tabsHtml() + '</div></div><div id="panel">' + panelHtml() + "</div></div></section>" +
      fullSection() +
      '<section class="rep-sec no-print"><div class="wrap"><div class="cta-band"><div class="dots" aria-hidden="true"></div><h2 class="h2" style="font-size:clamp(28px,3.2vw,40px)">Want these fixed?</h2><p class="lead">Get every fix built and tested on your store: speed, SEO and AI answers.</p><div class="row"><a class="btn btn-primary" href="' + esc(CFG.calendly || "#") + '" target="_blank" rel="noopener">Book a demo</a></div></div></div></section>' +
      '<section class="rep-sec"><div class="wrap"><p class="small" style="max-width:760px">Speed comes from Google PageSpeed Insights (Lighthouse lab test on an emulated phone, plus Chrome real-user data where Google has enough visits). Search and AI checks read your page\'s raw HTML, robots.txt, sitemap and llms.txt. Scores: pass = 1, warning = 0.5, fail = 0, averaged out of 100. Time savings are Google\'s own estimates.</p></div></section>';
  }

  function rerenderPanel() {
    $("#tabs").innerHTML = tabsHtml();
    $("#panel").innerHTML = panelHtml();
    $("#panel").querySelectorAll("circle.val[data-dash]").forEach(function (c) { c.style.transition = "none"; c.setAttribute("stroke-dasharray", c.getAttribute("data-dash")); });
  }
  function bindReport() {
    var rep = $("#report");
    rep.addEventListener("click", function (e) {
      var t = e.target.closest("[data-tab]"); if (t) { S.tab = t.getAttribute("data-tab"); rerenderPanel(); return; }
      var dv = e.target.closest("[data-dev]"); if (dv) { S.device = dv.getAttribute("data-dev"); rerenderPanel(); animateRings($("#panel")); return; }
      var df = e.target.closest("[data-def]"); if (df) { var k = df.getAttribute("data-def"); S.open[k] = !S.open[k]; rerenderPanel(); var b2 = $('[data-def="' + k + '"]'); if (b2) b2.focus(); return; }
      if (e.target.closest("[data-copy]")) { (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(function () { toast("Link copied"); }, function () { toast(location.href); }); return; }
      if (e.target.closest("[data-print]")) { downloadPdf(); return; }
      if (e.target.closest("[data-cmp-auto]")) { autoDetect(); return; }
      if (e.target.closest("[data-cmp-edit]")) { S.cmp.state = "empty"; renderCompare(); var c0 = $("#cmp0"); if (c0) c0.focus(); return; }
      if (e.target.closest("[data-cmp-go]")) { var cs = $("#compare") || $("#full"); if (cs) cs.scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(function () { var c1 = $("#cmp0") || $("#ldEmail"); if (c1) c1.focus({ preventScroll: true }); }, 500); return; }
      var rt = e.target.closest("[data-retry]"); if (rt) {
        rt.disabled = true; rt.textContent = "Running… about a minute";
        var dev = S.device;
        runPsi(URL0, dev).then(function (m) { S.psi[dev] = m; delete S.psiErr[dev]; }).catch(function (er) { S.psiErr[dev] = er && er.message || "failed"; }).then(function () { rep.innerHTML = renderReport(); animateRings(rep); });
      }
    });
    rep.addEventListener("input", function (e) { var i = e.target.getAttribute && e.target.getAttribute("data-cmp-in"); if (i != null) S.cmp.inputs[+i] = e.target.value; if (e.target.id === "ldEmail") emailHint(e.target); var lf = e.target.closest && e.target.closest("[data-lead-form]"); if (lf && e.target.name && e.target.closest(".lk-f.bad")) { var rr = leadRules(lf); if (rr[e.target.name]) fieldCheck(lf, rr, e.target.name); } });
    rep.addEventListener("focusout", function (e) { var lf = e.target.closest && e.target.closest("[data-lead-form]"); if (lf && e.target.value && e.target.name) { var rr = leadRules(lf); if (rr[e.target.name]) fieldCheck(lf, rr, e.target.name); } });
    rep.addEventListener("change", function (e) { if (e.target.name === "cc") { var lf = e.target.closest("[data-lead-form]"), v = e.target.value, p = lf.querySelector('[name="phone"]'); p.placeholder = v === "other" ? "+49 30 1234567" : v === "+44" ? "7700 900123" : v === "+61" ? "412 345 678" : v === "+971" ? "50 123 4567" : v === "+91" ? "98765 43210" : "(415) 555 0132"; } if (e.target.name === "orders") { var lf2 = e.target.closest("[data-lead-form]"); fieldCheck(lf2, leadRules(lf2), "orders"); } });
    rep.addEventListener("submit", function (e) { if (e.target.closest("[data-cmp-form]")) { e.preventDefault(); startCompare(); } else if (e.target.closest("[data-lead-form]")) { e.preventDefault(); submitLead(e.target.closest("[data-lead-form]")); } });
    rep.addEventListener("keydown", function (e) {
      var t = e.target.closest('[role="tab"]'); if (!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      var ids = ["speed", "search", "ai"], i = ids.indexOf(S.tab); S.tab = ids[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; rerenderPanel(); var b = $('[data-tab="' + S.tab + '"]'); if (b) b.focus();
    });
  }
  if (CFG.calendly) doc.querySelectorAll("[data-calendly]").forEach(function (a) { a.href = CFG.calendly; });
  // Every "Book a demo" (nav, fix plan, "Want these fixed?") opens Calendly in a new tab.
  doc.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href*="calendly.com"]'); if (!a) return;
    var where = a.closest("#nav, nav, header") ? "nav" : a.closest(".cta-band") ? "want_these_fixed" : a.closest("#full") ? "fix_plan" : a.closest("#panel") ? "performance_tab" : "report";
    track("book_demo", { cta: where, page: "trooperformance_report" });
    fb("Contact", { content_name: "Book a demo", content_category: where });
  }, true);
  var nav = $("#nav"); if (nav) { var os = function () { nav.classList.toggle("scrolled", win.scrollY > 8); }; win.addEventListener("scroll", os, { passive: true }); os(); }
})();
