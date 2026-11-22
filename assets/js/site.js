/* TrooPerformance landing: nav state, human/agent toggle, audit form. */
(function () {
  "use strict";
  var nav = document.getElementById("nav");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("scrolled", window.scrollY > 8); };
    window.addEventListener("scroll", onScroll, { passive: true }); onScroll();
  }

  // Human / Agent toggle
  document.querySelectorAll(".seg").forEach(function (seg) {
    var wrap = seg.parentElement;
    seg.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-view]"); if (!b) return;
      seg.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      wrap.querySelectorAll("[data-pane]").forEach(function (p) { p.hidden = p.getAttribute("data-pane") !== b.getAttribute("data-view"); });
    });
  });

  // Competitor toggle
  var vsT = document.getElementById("vsToggle"), vsR = document.getElementById("vsRow");
  if (vsT && vsR) vsT.addEventListener("click", function () {
    var open = vsR.hidden; vsR.hidden = !open; vsT.setAttribute("aria-expanded", String(open));
    vsT.textContent = open ? "− Remove competitors" : "+ Compare with competitors";
    if (open) document.getElementById("c1").focus();
  });

  function clean(v) {
    v = String(v || "").trim().replace(/\s+/g, "");
    if (!v) return "";
    v = v.replace(/^https?:\/\//i, "");
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(v)) return null;
    return "https://" + v;
  }
  var form = document.getElementById("auditForm");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var err = document.getElementById("formError");
    var u = clean(document.getElementById("u").value);
    if (!u) { err.textContent = "Enter your store's address, like yourstore.com"; err.hidden = false; document.getElementById("u").focus(); return; }
    err.hidden = true;
    var vs = [];
    if (vsR && !vsR.hidden) ["c1", "c2"].forEach(function (id) { var c = clean(document.getElementById(id).value); if (c) vs.push(c); });
    var q = "url=" + encodeURIComponent(u) + (vs.length ? "&vs=" + encodeURIComponent(vs.join(",")) : "");
    window.location.href = "audit.html?" + q;
  });

  var cfg = window.TP_CONFIG || {};
  if (cfg.calendly) document.querySelectorAll("[data-calendly]").forEach(function (a) { a.href = cfg.calendly; });
})();
