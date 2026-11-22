/* TrooPerformance audit: runs Google PageSpeed (mobile + desktop) and the Search/AI scan, animates the scan, then renders the report.
   Everything that comes from a scanned page is escaped before it touches the DOM. */
(function () {
  "use strict";
  var CFG = window.TP_CONFIG || {};
  var doc = document, win = window;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var G = "#4CC38A", A = "#E5A93D", R = "#EF6B57", P = "#A68EFA", DIM = "#6F6C7C";

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
  if (!URL0) { location.replace("./"); return; }
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
    return timeoutFetch("https://www.googleapis.com/pagespeedonline/v5/runPagespeed?" + p, {}, 100000).then(function (r) { return r.json(); });
  }
  function runPsi(u, strategy) {
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
    var third = (((a["third-party-summary"] || {}).details || {}).items || []).map(function (it) {
      var e = it.entity; return { name: typeof e === "string" ? e : (e && (e.text || e.name)) || "Unknown", size: it.transferSize || 0, block: it.blockingTime || 0, main: it.mainThreadTime || 0 };
    }).sort(function (x, y) { return (y.block - x.block) || (y.main - x.main); });
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
      field: field, thumbs: thumbs.map(function (t) { return { t: t.timing, src: t.data }; }), shot: shot, third: third, causes: causes
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
  meter("speed", "Speed", null, "measuring…"); meter("search", "Search", null, "measuring…"); meter("ai", "AI answers", null, "measuring…");
  var logEl = $("#log");
  function log(text, tag, tagColor, kind) {
    var d = doc.createElement("div"); d.className = "log-line " + (kind || "sub");
    d.innerHTML = '<span class="t">' + esc(text) + "</span>" + (tag ? '<span class="tag" style="color:' + (tagColor || DIM) + '">' + esc(tag) + "</span>" : "");
    logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
  }
  // phone build animation
  var t0 = Date.now();
  var clock = setInterval(function () { $("#clock").textContent = ((Date.now() - t0) / 1000).toFixed(1) + " s"; }, 100);
  [[500, "1"], [1400, "3"], [2300, "2"], [3600, "img"], [4600, "5"]].forEach(function (s) {
    setTimeout(function () {
      if (s[1] === "img") { var im = $('[data-ph="3"]'); if (im) im.classList.add("filled"); return; }
      var el = $('[data-ph="' + s[1] + '"]'); if (el) el.classList.add("on");
    }, s[0]);
  });
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
      log(d.blocked ? "firewall turned our check away" : "page returns " + d.status, "fail", R);
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
  }).catch(function () {
    S.scanErr = true; stage("google", "err"); stage("ai", "err");
    log("couldn't read this page's HTML", "error", R);
    meter("search", "Search", null, "couldn't check", R); meter("ai", "AI answers", null, "couldn't check", R);
  }).then(tick);

  var pMob = runPsi(URL0, "mobile").then(function (m) {
    S.psi.mobile = m; stage("mobile", "done");
    log("→ phone test done", "", "", "head");
    log("first paint " + sec(m.m.fcp), sec(m.m.fcp), mcol("fcp", m.m.fcp));
    log("main content (LCP)", sec(m.m.lcp), mcol("lcp", m.m.lcp));
    log("blocked time (TBT)", msf(m.m.tbt), mcol("tbt", m.m.tbt));
    if (m.third.length) log(m.third.length + " third-party apps · " + msf(m.third.reduce(function (s, x) { return s + x.block; }, 0)) + " blocking", "", A);
    if (m.field) { stage("field", "done"); log("real shoppers: LCP " + sec(m.field.lcp) + " · INP " + msf(m.field.inp), m.field.scope === "site" ? "site-wide" : "this page", mcol("lcp", m.field.lcp)); }
    else { stage("field", "done"); log("real-shopper data: not enough Chrome traffic", "n/a", DIM); }
    meter("speed", "Speed", m.perf, bandName(m.perf) + " · mobile", band(m.perf));
    var img = $("#shot"); var src = m.shot || (m.thumbs.length ? m.thumbs[m.thumbs.length - 1].src : "");
    if (src) { img.src = src; img.classList.add("on"); $("#beam").style.display = "none"; }
  }).catch(function (e) {
    S.psiErr.mobile = e && e.message || "failed"; stage("mobile", "err"); stage("field", "err");
    log("Google PageSpeed " + (S.psiErr.mobile === "busy" ? "is busy right now" : "didn't answer"), "retry later", A);
    meter("speed", "Speed", null, "PageSpeed busy", A);
  }).then(tick);
  stage("field", "active");

  var pDesk = runPsi(URL0, "desktop").then(function (m) {
    S.psi.desktop = m; stage("desktop", "done"); log("desktop score", String(m.perf), band(m.perf));
  }).catch(function (e) { S.psiErr.desktop = e && e.message || "failed"; stage("desktop", "err"); }).then(tick);
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

  Promise.all([pScan, pMob, pDesk].concat(pComps)).then(function () {
    if (VS.length) stage("comps", "done");
    clearInterval(clock); $("#spin").style.display = "none";
    log("report ready", "done", G, "head");
    setTimeout(showReport, 900);
  });

  // ---------- report ----------
  function showReport() {
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
    if (d && d.blocked) return { h: "Your firewall turns <span class=\"hl\">automated visitors away.</span>", l: "We couldn't read the page, and AI assistants probably can't either. Here's what we could check." };
    if (oai && !oai.allowed) return { h: "ChatGPT <span class=\"hl\">can't read your store.</span>", l: "Your robots.txt blocks ChatGPT's search crawler. Below is everything we found, sorted by what it costs you." };
    if (d && d.ai.score != null && d.ai.score < 60) return { h: "AI assistants <span class=\"hl\">can barely see your store.</span>", l: "Below is everything we found, sorted by what it costs you." };
    if (d && d.search.score != null && d.search.score < 70) return { h: "Google sees <span class=\"hl\">a weaker version of your store.</span>", l: "Below is everything we found, sorted by what it costs you." };
    return { h: "Your store is in good shape. <span class=\"hl\">Here's what's left.</span>", l: "Below is everything we found, sorted by what it costs you." };
  }

  function speedPanel() {
    var m = S.psi[S.device], err = S.psiErr[S.device];
    var toggle = '<span class="devtoggle no-print" role="group" aria-label="Device"><button type="button" data-dev="mobile" aria-pressed="' + (S.device === "mobile") + '">Mobile</button><button type="button" data-dev="desktop" aria-pressed="' + (S.device === "desktop") + '">Desktop</button></span>';
    if (!m) {
      return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>Speed · ' + S.device + "</span>" + toggle + '</p><div class="notice">' + (err === "busy" ? "Google PageSpeed is busy right now (it limits free tests per day)." : "Google PageSpeed didn't answer for this page.") + ' Try again in a minute.<button class="btn btn-ghost btn-sm" type="button" data-retry>Run speed test again</button></div></div></div>';
    }
    var left = '<p class="panel-title"><span>Speed · ' + S.device + " · Google PageSpeed " + m.perf + "/100</span>" + toggle + "</p>" +
      (m.causes.length ? m.causes.map(function (c) { var im = impactOf(c); return checkRow({ status: c.status, title: c.title, why: c.plain + " Who fixes it: " + c.who + ".", detail: c.audits.slice(0, 2).join(" | ") }, im[0], im[1]); }).join("")
        : '<div class="check"><span class="st pass">Pass</span><div class="ct"><b>No big savings left</b><span>Google found nothing major to fix on this page.</span></div><span></span></div>');
    var lcpT = m.m.lcp, film = m.thumbs.slice(0, 8), lcpIdx = -1;
    film.forEach(function (f, i) { if (lcpIdx < 0 && lcpT != null && f.t >= lcpT) lcpIdx = i; });
    var right = "";
    if (film.length) right += '<span class="vis-label">Your page loading, frame by frame' + (lcpT ? " · main content at " + sec(lcpT) : "") + '</span><div class="film">' + film.map(function (f, i) { return '<figure class="' + (i === lcpIdx ? "lcp" : "") + '"><img src="' + esc(f.src) + '" alt="Page at ' + sec(f.t) + '" loading="lazy"><figcaption>' + sec(f.t) + "</figcaption></figure>"; }).join("") + "</div>";
    var f = m.field;
    if (f) {
      var bar = function (label, v, k, max, fmt) {
        if (v == null) return "";
        var t = TH[k], pos = Math.min(98, v / max * 100);
        return '<div class="fbar"><div class="row"><span>' + label + '</span><b style="color:' + mcol(k, v) + '">' + fmt(v) + '</b></div><div class="track"><i style="width:' + (t[0] / max * 100) + '%"></i><i style="width:' + ((t[1] - t[0]) / max * 100) + '%"></i><i></i><em style="left:' + pos + '%"></em></div></div>';
      };
      var passed = f.lcp != null && f.lcp <= 2500 && (f.inp == null || f.inp <= 200) && (f.cls == null || f.cls <= 0.1);
      right += '<div class="box"><div class="row" style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><span class="vis-label">Real shoppers · last 28 days' + (f.scope === "site" ? " · whole site" : "") + '</span><span class="badge" style="color:' + (passed ? G : R) + ";border-color:" + (passed ? "rgba(76,195,138,.4)" : "rgba(239,107,87,.4)") + '">Core Web Vitals: ' + (passed ? "passed" : "failed") + "</span></div>" +
        bar("Main content shows (LCP)", f.lcp, "lcp", 6000, sec) + bar("Response to taps (INP)", f.inp, "inp", 700, msf) + bar("Layout jumps (CLS)", f.cls, "cls", 0.4, function (v) { return v.toFixed(2); }) + "</div>";
    } else {
      right += '<div class="box"><span class="vis-label">Real shoppers</span><span class="small">Chrome doesn\'t have enough visits to this page yet to report real-shopper speed. The lab test below is what we have.</span></div>';
    }
    right += '<div class="labm">' + [["First paint", "fcp", sec], ["Main content", "lcp", sec], ["Blocked time", "tbt", msf], ["Layout jumps", "cls", function (v) { return v == null ? "—" : v.toFixed(2); }], ["Speed Index", "si", sec]].map(function (x) { var v = m.m[x[1]]; return '<div><span>' + x[0] + '</span><b style="color:' + mcol(x[1], v) + '">' + x[2](v) + "</b></div>"; }).join("") + "</div>";
    right += '<div class="pills"><span class="chip">Accessibility ' + (m.a11y == null ? "–" : m.a11y) + '</span><span class="chip">Best practices ' + (m.bp == null ? "–" : m.bp) + '</span><span class="chip">Lighthouse SEO ' + (m.seo == null ? "–" : m.seo) + "</span></div>";
    var apps = "";
    if (m.third.length) {
      var top = m.third.filter(function (x) { return x.block >= 1 || x.main >= 50; }).slice(0, 8), mx = Math.max.apply(null, top.map(function (x) { return x.block || x.main || 1; }).concat([1]));
      var tb = m.third.reduce(function (s, x) { return s + x.block; }, 0), tk = m.third.reduce(function (s, x) { return s + x.size; }, 0);
      apps = '<div class="apps"><div class="head"><div><h3 class="h3" style="font-size:20px">App tax</h3><span class="small">Every third-party script on this page and what it costs a ' + S.device + " shopper</span></div><span class=\"mono\" style=\"font-size:13px;color:" + (tb > 500 ? R : A) + '">' + Math.round(tk / 1024).toLocaleString("en-IN") + " KB · " + msf(tb) + ' blocking</span></div><table><thead><tr><th scope="col">App / service</th><th scope="col" style="width:42%">Blocks the page for</th><th scope="col">Main thread</th><th scope="col">Size</th></tr></thead><tbody>' +
        top.map(function (x, i) { var v = x.block || 0, col = v >= 250 ? R : v >= 50 ? A : "#8B8BA0"; return '<tr><th scope="row" style="font-weight:400;text-align:left">' + esc(x.name) + '</th><td><div class="bar"><div><i style="width:' + Math.max(2, (x.block || 0) / mx * 100) + "%;background:" + col + ";animation-delay:" + (i * 0.06) + 's"></i></div><span>' + msf(x.block) + '</span></div></td><td class="mono" style="color:#CFCCD9">' + msf(x.main) + '</td><td class="mono" style="color:#A09DAD">' + Math.round(x.size / 1024).toLocaleString("en-IN") + " KB</td></tr>"; }).join("") +
        "</tbody></table></div>";
    }
    return '<div class="panel"><div class="panel-l">' + left + '</div><div class="panel-r">' + right + "</div></div>" + apps;
  }

  function searchPanel() {
    var d = S.scan;
    if (!d) return '<div class="panel"><div class="panel-l"><div class="notice">We couldn\'t read this page\'s HTML, so search checks didn\'t run. <button class="btn btn-ghost btn-sm" type="button" onclick="location.reload()">Run the audit again</button></div></div></div>';
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
      right += '<div class="notice">' + (d.blocked ? "Your server turned our check away (status " + esc(d.status) + "), so we could only read robots.txt and your sitemap." : "This page returns " + esc(d.status) + ". Check the address and run the audit again.") + "</div>";
    }
    return '<div class="panel"><div class="panel-l"><p class="panel-title"><span>Search checks · score ' + d.search.score + "/100</span><span>" + d.search.checks.length + " checks</span></p>" + checksBlock(d.search.checks) + '</div><div class="panel-r">' + right + "</div></div>";
  }

  function aiPanel() {
    var d = S.scan;
    if (!d) return '<div class="panel"><div class="panel-l"><div class="notice">We couldn\'t read this page, so AI checks didn\'t run. <button class="btn btn-ghost btn-sm" type="button" onclick="location.reload()">Run the audit again</button></div></div></div>';
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

  function compsSection() {
    if (!S.comps.length) return "";
    var cols = [{ url: URL0, psi: S.psi.mobile, scan: S.scan, you: true }].concat(S.comps);
    var cell = function (v, color) { return v == null ? '<span style="color:' + DIM + '">—</span>' : '<span style="color:' + (color || "#F4F3F8") + '">' + esc(v) + "</span>"; };
    var rows = [
      ["Mobile speed score", function (c) { return c.psi ? cell(c.psi.perf, band(c.psi.perf)) : cell(null); }],
      ["Main content on a phone (lab)", function (c) { return c.psi ? cell(sec(c.psi.m.lcp), mcol("lcp", c.psi.m.lcp)) : cell(null); }],
      ["Real shoppers see content in", function (c) { return c.psi && c.psi.field && c.psi.field.lcp ? cell(sec(c.psi.field.lcp), mcol("lcp", c.psi.field.lcp)) : cell(null); }],
      ["Third-party scripts blocking", function (c) { return c.psi ? cell(msf(c.psi.third.reduce(function (s, x) { return s + x.block; }, 0))) : cell(null); }],
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
    if (m) m.causes.forEach(function (c) { var im = impactOf(c); items.push({ w: Math.min(6, c.sav / 1000 * 2 + c.tbt / 1000) + (c.status === "fail" ? 1 : 0), tag: "Speed", title: c.title, why: c.plain, imp: im[0] }); });
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

  function tabCount(id) {
    if (id === "speed") { var m = S.psi[S.device]; return m ? m.causes.filter(function (c) { return c.status === "fail"; }).length : 0; }
    var d = S.scan; if (!d) return 0;
    return (id === "search" ? d.search : d.ai).checks.filter(function (c) { return c.status === "fail"; }).length;
  }
  function tabsHtml() {
    return [["speed", "Speed"], ["search", "Search"], ["ai", "AI answers"]].map(function (t) { var n = tabCount(t[0]); return '<button type="button" role="tab" data-tab="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + (n ? '<span class="cnt">' + n + "</span>" : "") + "</button>"; }).join("");
  }
  function panelHtml() { return S.tab === "speed" ? speedPanel() : S.tab === "search" ? searchPanel() : aiPanel(); }

  function renderReport() {
    var hl = headline(), m = S.psi.mobile, dsk = S.psi.desktop, d = S.scan;
    var date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    var wa = "https://wa.me/" + (CFG.whatsapp || "919810483552") + "?text=" + encodeURIComponent("Hi Troopod, I just ran the TrooPerformance audit for " + host(URL0) + " and want help fixing it: " + location.href);
    return '<section class="rep-hero"><div class="dots" aria-hidden="true"></div><div class="glow2" aria-hidden="true"></div><div class="wrap"><div class="txt">' +
      '<div class="tagrow"><span class="eyebrow">Report · ' + esc(host(URL0)) + " · " + esc(date) + "</span>" + (d && d.platform ? '<span class="badge">' + esc(d.platform) + "</span>" : "") + "</div>" +
      '<h1 class="h1">' + hl.h + '</h1><p class="lead" style="max-width:580px">' + esc(hl.l) + '</p><div class="no-print" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ghost btn-sm" type="button" data-copy>Copy link</button><button class="btn btn-ghost btn-sm" type="button" data-print>Download PDF</button></div></div>' +
      '<div class="scores">' +
      '<div class="score">' + ring(m ? m.perf : null, 92, 9) + "<b>Speed</b><span style=\"color:" + band(m && m.perf) + '">' + (m ? bandName(m.perf) : "No data") + '</span><span class="sub2">' + (dsk ? "desktop " + dsk.perf : "mobile") + "</span></div>" +
      '<div class="score">' + ring(d ? d.search.score : null, 92, 9) + "<b>Search</b><span style=\"color:" + band(d && d.search.score) + '">' + (d ? bandName(d.search.score) : "No data") + '</span><span class="sub2">' + (d ? d.search.checks.length + " checks" : "") + "</span></div>" +
      '<div class="score">' + ring(d ? d.ai.score : null, 92, 9) + "<b>AI answers</b><span style=\"color:" + band(d && d.ai.score) + '">' + (d ? bandName(d.ai.score) : "No data") + '</span><span class="sub2">' + (d ? d.ai.checks.length + " checks" : "") + "</span></div>" +
      "</div></div></section>" +
      '<section class="rep-sec"><div class="wrap"><div class="rep-sec-head"><h2 class="h2">What we found</h2><div class="tabs no-print" role="tablist" aria-label="Report area" id="tabs">' + tabsHtml() + '</div></div><div id="panel">' + panelHtml() + "</div></div></section>" +
      fixList() + compsSection() +
      '<section class="rep-sec no-print"><div class="wrap"><div class="cta-band"><div class="dots" aria-hidden="true"></div><h2 class="h2" style="font-size:clamp(28px,3.2vw,40px)">Want these fixed for you?</h2><p class="lead">TrooPerformance builds and tests the fixes on your store: speed, SEO and AI answers.</p><div class="row"><a class="btn btn-primary" href="' + esc(CFG.calendly || "#") + '" target="_blank" rel="noopener">Book a demo</a><a class="btn btn-ghost" href="' + esc(wa) + '" target="_blank" rel="noopener">WhatsApp us</a></div></div></div></section>' +
      '<section class="rep-sec"><div class="wrap"><p class="small" style="max-width:760px">Speed comes from Google PageSpeed Insights (Lighthouse lab test on an emulated phone, plus Chrome real-user data where Google has enough visits). Search and AI checks read your page\'s raw HTML, robots.txt, sitemap and llms.txt. Scores: pass = 1, warning = 0.5, fail = 0, averaged out of 100. Time savings are Google\'s own estimates.</p></div></section>';
  }

  function rerenderPanel() {
    $("#tabs").innerHTML = tabsHtml();
    $("#panel").innerHTML = panelHtml();
  }
  function bindReport() {
    var rep = $("#report");
    rep.addEventListener("click", function (e) {
      var t = e.target.closest("[data-tab]"); if (t) { S.tab = t.getAttribute("data-tab"); rerenderPanel(); return; }
      var dv = e.target.closest("[data-dev]"); if (dv) { S.device = dv.getAttribute("data-dev"); rerenderPanel(); return; }
      if (e.target.closest("[data-copy]")) { (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(function () { toast("Link copied"); }, function () { toast(location.href); }); return; }
      if (e.target.closest("[data-print]")) { win.print(); return; }
      var rt = e.target.closest("[data-retry]"); if (rt) {
        rt.disabled = true; rt.textContent = "Running… about a minute";
        var dev = S.device;
        runPsi(URL0, dev).then(function (m) { S.psi[dev] = m; delete S.psiErr[dev]; }).catch(function (er) { S.psiErr[dev] = er && er.message || "failed"; }).then(function () { rep.innerHTML = renderReport(); animateRings(rep); });
      }
    });
    rep.addEventListener("keydown", function (e) {
      var t = e.target.closest('[role="tab"]'); if (!t || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
      var ids = ["speed", "search", "ai"], i = ids.indexOf(S.tab); S.tab = ids[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3]; rerenderPanel(); var b = $('[data-tab="' + S.tab + '"]'); if (b) b.focus();
    });
  }
  if (CFG.calendly) doc.querySelectorAll("[data-calendly]").forEach(function (a) { a.href = CFG.calendly; });
  var nav = $("#nav"); if (nav) { var os = function () { nav.classList.toggle("scrolled", win.scrollY > 8); }; win.addEventListener("scroll", os, { passive: true }); os(); }
})();
