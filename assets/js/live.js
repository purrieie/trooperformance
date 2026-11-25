/* TrooPerformance live scan view: the shopper's real page, drawn in a frame, with the agents working on it.
   The page is fetched through the TrooCRO page-view function and drawn without any of its scripts, so nothing on the store runs.
   audit.js drives it: TPLive.start(url), .agent(id, state, text), .result(agent, region, kind, label), .shot(src), .finish(). */
(function () {
  "use strict";
  var CFG = window.TP_CONFIG || {}, doc = document, win = window;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var REDUCED = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);

  var AGENTS = [
    { id: "reader", name: "Reader", role: "Opens and maps your page", c: "#CBBEFD" },
    { id: "speed", name: "Speed", role: "Times your page on a phone", c: "#E5A93D" },
    { id: "search", name: "Search", role: "Checks what Google sees", c: "#4CC38A" },
    { id: "ai", name: "AI bots", role: "Checks what ChatGPT can read", c: "#7FD1C7" },
    { id: "desk", name: "Desktop", role: "Runs the laptop test", c: "#A68EFA" }
  ];
  var AG = {}; AGENTS.forEach(function (a) { AG[a.id] = a; });
  /* what each agent does, and where on the page it does it */
  var PLAN = {
    reader: [["nav", "Mapping the header and menu"], ["title", "Finding what you sell"], ["img", "Reading the main images"], ["content", "Reading every section"], ["footer", "Checking the footer links"]],
    speed: [["img", "Timing the largest image"], ["cta", "Counting scripts that block taps"], ["content", "Watching for layout jumps"], ["nav", "Loading on a mid-range phone"]],
    search: [["title", "Reading your title and H1"], ["price", "Checking product schema"], ["img", "Checking image alt text"], ["footer", "Reading your sitemap"]],
    ai: [["content", "Reading text without JavaScript"], ["price", "Looking for your price in the HTML"], ["footer", "Asking robots.txt about GPTBot"], ["title", "Looking for llms.txt"]],
    desk: [["nav", "Loading on a laptop"], ["img", "Timing the desktop page"]]
  };
  var RNAME = { nav: "Header", title: "Headline", img: "Main image", price: "Price", cta: "Buy button", reviews: "Reviews", content: "Page text", footer: "Footer" };

  var st = {}, line = {}, step = {}, RV = null, results = [], pins = [], boxes = [], running = false, finished = false, cur = null, rr = 0, host = "";

  /* ---------- roster ---------- */
  function buildRoster() {
    $("#lvAgents").innerHTML = AGENTS.map(function (a) {
      return '<div class="lv-a" data-ag="' + a.id + '" style="--c:' + a.c + '"><span class="lv-av"><i></i><b>' + esc(a.name.charAt(0)) + '</b></span><div class="lv-a-b"><div class="lv-a-t"><b>' + esc(a.name) + '</b><span class="lv-st">Queued</span></div><div class="lv-a-r">' + esc(a.role) + '</div><div class="lv-a-s" data-s></div></div></div>';
    }).join("");
    $("#lvFx").innerHTML = AGENTS.map(function (a) {
      return '<div class="lv-cur" data-cur="' + a.id + '" style="--c:' + a.c + '"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 1.5 14 7.2 8.6 8.6 6.6 14Z" fill="' + a.c + '" stroke="#0A0A0C" stroke-width="1.2" stroke-linejoin="round"/></svg><span>' + esc(a.name) + "</span></div>";
    }).join("");
    AGENTS.forEach(function (a) { park(a.id); });
  }
  function typeInto(el, text) {
    if (!el) return;
    clearInterval(el._tt);
    if (REDUCED) { el.textContent = text; return; }
    var i = 0; el.textContent = "";
    el._tt = setInterval(function () { i += 2; el.textContent = text.slice(0, i); if (i >= text.length) clearInterval(el._tt); }, 18);
  }
  function caption(id, text) {
    var a = AG[id], el = $("#lvNow"); if (!a || !el) return;
    el.style.setProperty("--c", a.c);
    el.innerHTML = '<i></i><b>' + esc(a.name) + "</b><span></span>";
    typeInto($("span", el), text);
  }
  function setLine(id, text) {
    line[id] = text;
    var row = $('[data-ag="' + id + '"]'); if (row) typeInto($("[data-s]", row), text);
  }
  function updCount() {
    var run = AGENTS.filter(function (a) { return st[a.id] === "run"; }).length;
    var done = AGENTS.filter(function (a) { return st[a.id] === "done" || st[a.id] === "fail"; }).length;
    $("#lvActive").textContent = done === AGENTS.length ? "All done" : run ? run + " working" : "Starting";
  }
  function agent(id, state, text) {
    var row = $('[data-ag="' + id + '"]'); if (!row) return;
    if (state === "run" && (st[id] === "done" || st[id] === "fail")) state = null; /* a finished agent never restarts */
    if (state && st[id] !== state) {
      st[id] = state;
      row.classList.remove("run", "done", "fail"); row.classList.add(state);
      $(".lv-st", row).textContent = state === "run" ? "Working" : state === "done" ? "Done" : state === "fail" ? "Couldn't run" : "Queued";
      var c = $('[data-cur="' + id + '"]'); if (c) c.classList.toggle("on", state === "run");
      if (state !== "run") park(id);
      updCount();
    }
    if (text != null) setLine(id, text);
    else if (state === "run" && !line[id]) setLine(id, PLAN[id][0][1]);
    if (state === "run") kick();
  }

  /* ---------- the page ---------- */
  function clean(html) {
    return String(html)
      .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "")
      .replace(/<link\b[^>]*rel=["']?(?:preload|prefetch|modulepreload)[^>]*>/gi, "")
      .replace(/(<video\b[^>]*?)\sautoplay\b/gi, "$1");
  }
  function load(url) {
    var base = String(CFG.pageView || "").replace(/\/+$/, "");
    if (!base || !win.fetch) return Promise.resolve(null);
    var ctl = win.AbortController ? new AbortController() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : 0;
    return fetch(base + "?raw=1&url=" + encodeURIComponent(url), { signal: ctl ? ctl.signal : undefined })
      .then(function (r) { clearTimeout(t); return r.ok ? r.json() : null; })
      .then(function (v) { return v && v.html && v.html.length > 300 ? v.html : null; })
      .catch(function () { clearTimeout(t); return null; });
  }
  function size() {
    var view = $("#lvView"); if (!view) return null;
    var W = view.clientWidth, H = view.clientHeight, vw = W < 600 ? 390 : 1280;
    return { W: W, H: H, vw: vw, scale: W / vw };
  }
  function mount(html) {
    return new Promise(function (res) {
      var view = $("#lvView"), z = size(); if (!view || !z) return res(false);
      var fr = doc.createElement("iframe");
      fr.setAttribute("sandbox", "allow-same-origin");
      fr.setAttribute("title", "Your page, as the agents see it");
      fr.setAttribute("tabindex", "-1"); fr.setAttribute("aria-hidden", "true");
      fr.setAttribute("scrolling", "no");
      fr.className = "lv-frame";
      fr.style.width = z.vw + "px"; fr.style.height = Math.ceil(z.H / z.scale) + "px"; fr.style.transform = "scale(" + z.scale + ")";
      var holder = doc.createElement("div"); holder.className = "lv-real"; holder.appendChild(fr);
      view.insertBefore(holder, $("#lvFx"));
      var done = false;
      function ready() {
        if (done) return; done = true;
        var d, w;
        try { d = fr.contentDocument; w = fr.contentWindow; } catch (e) { holder.remove(); return res(false); }
        if (!d || !d.body) { holder.remove(); return res(false); }
        $$("img", d).forEach(function (im) {
          var ds = im.getAttribute("data-src") || im.getAttribute("data-lazy-src") || im.getAttribute("data-original");
          var dss = im.getAttribute("data-srcset");
          if (ds && (!im.getAttribute("src") || /data:image|placeholder|blank/i.test(im.getAttribute("src")))) im.setAttribute("src", ds.replace(/\{width\}/g, "800"));
          if (dss && !im.getAttribute("srcset")) im.setAttribute("srcset", dss.replace(/\{width\}/g, "800"));
          im.removeAttribute("loading");
        });
        $$("video", d).forEach(function (v) { try { v.pause(); v.preload = "none"; } catch (e) { /* skip */ } });
        /* things that cover the page in a copy with no scripts: cookie bars, pop-ups, age gates */
        var css = d.createElement("style");
        css.textContent = "[class*=cookie],[id*=cookie],[class*=popup],[id*=popup],[class*=modal][aria-hidden=false],[class*=newsletter-popup],[class*=age-gate]{display:none!important}html,body{overflow:hidden!important;scrollbar-width:none}::-webkit-scrollbar{display:none}";
        (d.head || d.body).appendChild(css);
        setTimeout(function () {
          var text = (d.body.innerText || "").replace(/\s+/g, " ").length, els = regions(d, w);
          if (text < 250 || (!els.title && !els.cta)) { holder.remove(); return res(false); }
          RV = { fr: fr, d: d, w: w, scale: z.scale, H: z.H, vw: z.vw, els: els };
          holder.classList.add("on"); $("#lv").classList.add("is-real");
          res(true);
        }, 700);
      }
      fr.addEventListener("load", ready);
      setTimeout(ready, 7000);
      fr.srcdoc = html;
    });
  }
  function regions(d, w) {
    var ATC = /add to (cart|bag|basket)|buy (it )?now|add to order|shop now|order now|shop the|explore/i;
    function ok(el, maxTop) {
      if (!el || !el.getBoundingClientRect) return false;
      var r = el.getBoundingClientRect(), cs = w.getComputedStyle(el);
      if (r.width < 24 || r.height < 10 || cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) return false;
      return maxTop == null || r.top + (w.scrollY || 0) < maxTop;
    }
    function first(sel, test, maxTop) {
      var L; try { L = d.querySelectorAll(sel); } catch (e) { return null; }
      for (var i = 0; i < L.length && i < 400; i++) if (ok(L[i], maxTop) && (!test || test(L[i]))) return L[i];
      return null;
    }
    function tx(el) { return (el.innerText || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(); }
    var R = {};
    R.nav = first("header") || first("nav") || first("[class*=header]");
    R.title = first("main h1, h1") || first("main h2, h2", null, 1600);
    R.cta = first("button, input[type=submit], a", function (el) { var t = tx(el); return t.length < 40 && ATC.test(t); }, 2600) ||
      first("a[class*=btn], a[class*=button], button", function (el) { var t = tx(el); return t.length > 2 && t.length < 30; }, 1400);
    R.price = first("[class*=price]", function (el) { var t = tx(el); return /\d/.test(t) && t.length < 90; }, 2000);
    R.img = first("main img, img", function (el) { var r = el.getBoundingClientRect(); return r.width > 180 && r.height > 120; }, 1800);
    R.content = first("[class*=description], .rte, [class*=accordion]", function (el) { return tx(el).length > 40; }) || first("main p, p", function (el) { return tx(el).length > 60; }) || first("main h2, h2");
    R.footer = first("footer") || first("[class*=footer]");
    var fb = { price: "cta", cta: "title", img: "title", content: "img", nav: "title", title: "img", footer: "content" };
    Object.keys(fb).forEach(function (k) { if (!R[k]) R[k] = R[fb[k]] || null; });
    return R;
  }
  function rect(name) {
    var fx = $("#lvFx"); if (!fx) return null;
    var W = fx.clientWidth, H = fx.clientHeight;
    if (RV) {
      var el = RV.els[name]; if (!el) return null;
      var b = el.getBoundingClientRect(), s = RV.scale;
      var x = Math.max(0, b.left * s), y = b.top * s, w = Math.min(b.width * s, W - 8 - x), h = Math.min(b.height * s, H * 0.7);
      return { x: x, y: y, w: Math.max(24, w), h: Math.max(16, h), W: W, H: H };
    }
    var sk = $('#lvSkel [data-r="' + name + '"]'); if (!sk) return null;
    var a = fx.getBoundingClientRect(), r = sk.getBoundingClientRect();
    return { x: r.left - a.left, y: r.top - a.top, w: r.width, h: r.height, W: W, H: H };
  }

  /* ---------- camera and cursors ---------- */
  function ease(k) { return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; }
  function pageMax() {
    if (!RV) return 0;
    var de = RV.d.documentElement, h = Math.max(de.scrollHeight || 0, RV.d.body ? RV.d.body.scrollHeight : 0);
    return Math.max(0, Math.min(h, 14000) - RV.H / RV.scale);
  }
  function scrollTo(y) { if (RV) { RV.w.scrollTo(0, y); place(); } }
  function camTo(name) {
    return new Promise(function (res) {
      if (!RV || !RV.els[name]) return res();
      var w = RV.w, viewH = RV.H / RV.scale, b = RV.els[name].getBoundingClientRect(), from = w.scrollY || 0;
      var inView = b.top > viewH * 0.08 && b.top + Math.min(b.height, viewH * 0.4) < viewH * 0.85;
      var to = inView ? from : Math.min(pageMax(), Math.max(0, b.top + from - viewH * 0.24));
      var dy = Math.abs(to - from) * RV.scale, dur = REDUCED || dy < 3 ? 0 : Math.round(Math.min(1500, 480 + dy * 0.5));
      if (!dur) { if (to !== from) scrollTo(to); return res(); }
      var t0 = performance.now();
      (function f(now) {
        var k = Math.min(1, (now - t0) / dur);
        scrollTo(from + (to - from) * ease(k));
        if (k < 1) win.requestAnimationFrame(f); else res();
      })(t0);
    });
  }
  function camTop() {
    return new Promise(function (res) {
      if (!RV) return res();
      var from = RV.w.scrollY || 0, dur = REDUCED || from < 3 ? 0 : Math.round(Math.min(1600, 500 + from * RV.scale * 0.4)), t0 = performance.now();
      if (!dur) { scrollTo(0); return res(); }
      (function f(now) { var k = Math.min(1, (now - t0) / dur); scrollTo(from * (1 - ease(k))); if (k < 1) win.requestAnimationFrame(f); else res(); })(t0);
    });
  }
  function moveCur(id, x, y, dur) {
    var c = $('[data-cur="' + id + '"]'); if (!c) return;
    c.style.transitionDuration = (dur || 600) + "ms";
    c.style.transform = "translate(" + Math.round(x) + "px," + Math.round(y) + "px)";
  }
  function park(id) {
    var fx = $("#lvFx"); if (!fx) return;
    var i = AGENTS.map(function (a) { return a.id; }).indexOf(id), W = fx.clientWidth, H = fx.clientHeight;
    var c = $('[data-cur="' + id + '"]'); if (c) c.classList.add("parked");
    moveCur(id, W - 26, H * (0.12 + i * 0.17), 700);
  }
  function boxAt(el, r) { el.style.left = (r.x - 3) + "px"; el.style.top = (r.y - 3) + "px"; el.style.width = (r.w + 6) + "px"; el.style.height = (r.h + 6) + "px"; }
  function place() {
    boxes = boxes.filter(function (b) { return b.el.isConnected; });
    boxes.forEach(function (b) { var r = rect(b.region); if (r) boxAt(b.el, r); });
    pins.forEach(function (p) {
      var r = rect(p.region); if (!r) return;
      p.el.style.left = Math.max(4, Math.min(r.x + 6, r.W - p.el.offsetWidth - 6)) + "px";
      p.el.style.top = (r.y + r.h - 12 - p.slot * 26) + "px";
      p.el.style.opacity = r.y + r.h < 6 || r.y + r.h > r.H - 4 ? "0" : "";
    });
  }
  function clearBoxes() { boxes.forEach(function (b) { b.el.classList.add("out"); var e = b.el; setTimeout(function () { e.remove(); }, 450); }); boxes = []; }
  function focus(id, region, text, kind) {
    var r = rect(region), fx = $("#lvFx"); if (!r || !fx) return;
    clearBoxes();
    var a = AG[id], b = doc.createElement("div");
    b.className = "lv-box" + (kind ? " " + kind : "");
    b.style.setProperty("--c", kind === "ok" ? "#4CC38A" : kind === "warn" ? "#E5A93D" : kind === "bad" ? "#EF6B57" : a.c);
    boxAt(b, r);
    b.innerHTML = (kind ? "" : '<i class="lv-beam"></i>') + '<span class="lv-tag' + (r.y < 34 ? " in" : "") + '"><b>' + esc(kind ? a.name : RNAME[region] || region) + "</b><em>" + esc(text) + "</em></span>";
    fx.appendChild(b); boxes.push({ el: b, region: region });
  }
  function pin(region, label, kind) {
    var fx = $("#lvFx"); if (!fx || !rect(region)) return;
    var slot = pins.filter(function (p) { return p.region === region; }).length; if (slot > 2) return;
    var el = doc.createElement("span");
    el.className = "lv-pin " + (kind || "ok");
    el.textContent = label;
    fx.appendChild(el); pins.push({ el: el, region: region, slot: slot });
    place();
  }
  /* one agent visits one part of the page: camera scrolls, the cursor glides with it, the part lights up */
  function visit(id, region, text, kind) {
    cur = id;
    var r0 = rect(region); if (!r0) return Promise.resolve();
    AGENTS.forEach(function (a) {
      var c = $('[data-cur="' + a.id + '"]'); if (c) c.classList.toggle("on", a.id === id || st[a.id] === "run");
      if (a.id !== id) park(a.id);
    });
    var spot = [0.3 + Math.random() * 0.4, 0.3 + Math.random() * 0.4];
    return camTo(region).then(function () {
      var r = rect(region); if (!r) return;
      var c = $('[data-cur="' + id + '"]'); if (c) c.classList.remove("parked");
      moveCur(id, r.x + r.w * spot[0], r.y + Math.min(r.h * spot[1], 40), 650);
      return sleep(REDUCED ? 0 : 520).then(function () { focus(id, region, text, kind); caption(id, text); });
    });
  }

  /* ---------- the loop: results first, then whoever is working takes the next part of the page ---------- */
  function kick() { if (!running && !finished) { running = true; loop(); } }
  function loop() {
    if (finished) { running = false; return; }
    var job = results.shift();
    if (job) {
      return visit(job.agent, job.region, job.label, job.kind).then(function () { if (job.kind) pin(job.region, job.label, job.kind); return sleep(REDUCED ? 300 : job.kind ? 1300 : 700); }).then(loop);
    }
    var live = AGENTS.filter(function (a) { return st[a.id] === "run"; });
    if (!live.length) { running = false; clearBoxes(); return; }
    var a = live[rr++ % live.length], k = step[a.id] = (step[a.id] || 0) + 1;
    var pl = PLAN[a.id][k % PLAN[a.id].length], region = pl[0], think = pl[1];
    setLine(a.id, think);
    return visit(a.id, region, think).then(function () { return sleep(REDUCED ? 600 : 1500); }).then(loop);
  }

  /* ---------- API ---------- */
  function start(url) {
    try { var u = new URL(url); host = u.hostname.replace(/^www\./, "") + (u.pathname.length > 1 ? u.pathname.replace(/\/$/, "") : ""); } catch (e) { host = url; }
    $("#lvUrl").textContent = "Opening " + host + "…";
    buildRoster();
    agent("reader", "run", "Opening your page");
    caption("reader", "Opening " + host);
    load(url).then(function (html) { return html ? mount(clean(html)) : false; }).then(function (ok) {
      $("#lvUrl").textContent = host + (ok ? "" : " · preview");
      if (ok) { $("#lv").classList.add("loaded"); agent("reader", null, "Loaded your live page"); }
      else agent("reader", null, "Reading the page Google loads");
      /* the reader walks the page once, top to bottom, then hands over */
      var tour = ["nav", "title", "img", "price", "content", "footer"].filter(function (r) { return rect(r); }).slice(0, ok ? 6 : 3);
      tour.forEach(function (r) { results.push({ agent: "reader", region: r, label: (RNAME[r] || r) + " mapped", kind: null, tour: true }); });
      setTimeout(function () { results = results.filter(function (j) { return !j.tour; }); agent("reader", "done", ok ? "Mapped your page" : "Mapped from Google's view"); }, ok ? 16000 : 7000);
      kick();
    });
    win.addEventListener("resize", function () {
      if (!RV) { place(); return; }
      var z = size(); if (!z) return;
      RV.scale = z.W / RV.vw; RV.H = z.H;
      RV.fr.style.transform = "scale(" + RV.scale + ")"; RV.fr.style.height = Math.ceil(z.H / RV.scale) + "px";
      place();
    });
  }
  function result(agentId, region, kind, label) { if (!finished) { results.push({ agent: agentId, region: region, kind: kind, label: label }); kick(); } }
  function shot(src) {
    if (RV || !src) return;
    var im = $("#shot"); if (!im) return;
    im.src = src; im.classList.add("on"); $("#lv").classList.add("has-shot");
  }
  /* wrap up: leftover results become pins straight away, the camera goes back to the top */
  function finish() {
    var left = results.splice(0);
    left.forEach(function (j) { if (j.kind) pin(j.region, j.label, j.kind); });
    finished = true; clearBoxes();
    AGENTS.forEach(function (a) { if (st[a.id] === "run") agent(a.id, "done"); park(a.id); });
    $("#lv").classList.add("is-done");
    caption("reader", "Report ready");
    return camTop().then(function () { return sleep(REDUCED ? 0 : 700); });
  }

  win.TPLive = { start: start, agent: agent, result: result, shot: shot, finish: finish };
})();
