/* TrooPerformance branded report: ONE renderer for the PDF download (browser) and the report email
   (sent from tools/report-queue/queue.mjs after approval). Email-safe on purpose: tables, inline styles,
   hosted images, no CSS gradients or SVG that mail apps drop. */
(function (root) {
  "use strict";
  var C = { bg: "#0A0A0C", card: "#131219", card2: "#1A1630", line: "#2A2638", text: "#F4F3F8", text2: "#CFCCD9", muted: "#A09DAD", dim: "#6F6C7C", purple: "#8B6BF7", lilac: "#CBBEFD", good: "#4CC38A", warn: "#E5A93D", bad: "#EF6B57" };
  var F = "'DM Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif", M = "'DM Mono',ui-monospace,Menlo,Consolas,monospace";
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function band(n) { return n == null ? C.dim : n >= 90 ? C.good : n >= 50 ? C.warn : C.bad; }
  function bandName(n) { return n == null ? "No data" : n >= 90 ? "Good" : n >= 50 ? "Needs work" : "Poor"; }
  function kcol(k) { return k === "ok" ? C.good : k === "warn" ? C.warn : k === "bad" ? C.bad : C.dim; }
  function kname(k) { return k === "ok" ? "Good" : k === "warn" ? "Needs work" : k === "bad" ? "Poor" : "No data"; }
  function pill(text, color) { return '<span style="display:inline-block;padding:3px 9px;border-radius:999px;border:1px solid ' + color + ';color:' + color + ';font-family:' + M + ';font-size:11px;line-height:16px;white-space:nowrap">' + esc(text) + "</span>"; }
  function h2(eyebrow, title, accent) {
    return '<tr><td style="padding:34px 32px 14px"><div style="font-family:' + M + ';font-size:11.5px;letter-spacing:.06em;text-transform:uppercase;color:' + C.lilac + '">' + esc(eyebrow) + '</div><div style="margin-top:8px;font-family:' + F + ';font-size:26px;line-height:32px;letter-spacing:-.02em;color:' + C.text + '">' + esc(title) + (accent ? ' <span style="color:#A68EFA">' + esc(accent) + "</span>" : "") + "</div></td></tr>";
  }
  function card(inner, pad) { return '<tr><td style="padding:0 24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.card + ';border:1px solid ' + C.line + ';border-radius:16px"><tr><td style="padding:' + (pad || "20px 22px") + '">' + inner + "</td></tr></table></td></tr>"; }
  function rule(base) { return '<tr><td style="padding:22px 32px 0"><img src="' + base + 'assets/email/holo-rule.png" width="536" height="3" alt="" style="display:block;width:100%;max-width:536px;height:3px;border:0"></td></tr>'; }
  function scoreTile(n, label, sub, base) {
    var c = band(n);
    return '<td width="33%" align="center" valign="top" style="padding:6px">' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="background:' + C.card2 + ';border:1px solid ' + C.line + ';border-radius:16px;width:100%"><tr><td align="center" style="padding:18px 6px 16px">' +
      // the ring is an image (assets/email/rings/<score>.png): mail apps stretch CSS circles into ovals
      '<img src="' + base + 'assets/email/rings/' + (n == null ? "na" : Math.max(0, Math.min(100, Math.round(n)))) + '.png" width="84" height="84" alt="' + (n == null ? "no score" : n + " out of 100") + '" style="display:block;margin:0 auto;width:84px;height:84px;max-width:84px;border:0;outline:none">' +
      '<div style="margin-top:12px;font-family:' + F + ';font-size:15px;color:' + C.text + '">' + esc(label) + '</div><div style="margin-top:3px;font-family:' + M + ';font-size:11px;color:' + c + '">' + esc(bandName(n)) + "</div>" +
      (sub ? '<div style="margin-top:2px;font-family:' + M + ';font-size:10.5px;color:' + C.dim + '">' + esc(sub) + "</div>" : "") +
      "</td></tr></table></td>";
  }
  function checkRows(list) {
    return list.map(function (c) {
      var col = c.status === "fail" ? C.bad : c.status === "warn" ? C.warn : C.good, lab = c.status === "fail" ? "Fail" : c.status === "warn" ? "Warn" : "Pass";
      return '<tr><td valign="top" width="56" style="padding:10px 0;border-top:1px solid ' + C.line + '">' + pill(lab, col) + '</td><td valign="top" style="padding:10px 0 10px 10px;border-top:1px solid ' + C.line + '"><div style="font-family:' + F + ';font-size:14.5px;color:' + C.text + '">' + esc(c.title) + "</div>" + (c.why ? '<div style="margin-top:3px;font-family:' + F + ';font-size:13px;line-height:19px;color:' + C.muted + '">' + esc(c.why) + "</div>" : "") + "</td></tr>";
    }).join("");
  }

  // email opening: who they are, what they checked, what's in it for them, one button
  function intro(d, site, sc, up) {
    var hi = d.name ? "Hi " + esc(d.name) + "," : "Hi there,";
    var l1 = hi + " you just checked <b style=\"color:" + C.text + ";font-weight:500\">" + site + "</b> on TrooPerformance. Here’s your full report.";
    var l2 = sc.perf != null && up && up.target > sc.perf
      ? "Your site scores <b style=\"color:" + band(sc.perf) + ";font-weight:500\">" + sc.perf + "/100</b> on a phone. Getting it to <b style=\"color:" + C.lilac + ";font-weight:500\">" + up.target + "</b> could mean about <b style=\"color:" + C.lilac + ";font-weight:500\">+" + up.conv + "% more conversions</b> from the same traffic."
      : sc.perf != null ? "Your site scores <b style=\"color:" + band(sc.perf) + ";font-weight:500\">" + sc.perf + "/100</b> on a phone. The fixes below keep it ahead of your competitors." : "Below are the fixes that matter most, ranked by what they cost you.";
    var l3 = "Want it done for you? Book a quick call and see exactly how.";
    return '<div style="margin-top:14px;font-family:' + F + ';font-size:15.5px;line-height:24px;color:' + C.text2 + '">' + l1 + "<br>" + l2 + "<br>" + l3 + "</div>" +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px"><tr><td style="border-radius:10px;background:' + C.purple + '"><a href="' + esc(d.demoUrl || "https://calendly.com/nj-troopod/troopod-demo") + '" style="display:inline-block;padding:12px 20px;font-family:' + F + ';font-size:15px;font-weight:500;color:#FFFFFF;text-decoration:none">Book a demo &rarr;</a></td></tr></table>';
  }

  function render(d, opt) {
    opt = opt || {};
    var base = opt.assetBase || "https://purrieie.github.io/trooperformance/", print = opt.mode === "print";
    var site = esc(d.site), sc = d.scores || {}, up = d.uplift || null, rows = "";
    var pb = print ? "break-before:page;page-break-before:always;" : "";

    // cover
    rows += '<tr><td style="padding:0"><img src="' + base + 'assets/email/holo-header.png" width="600" alt="TrooPerformance site audit by Troopod" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>';
    rows += '<tr><td style="padding:30px 32px 6px"><div style="font-family:' + M + ';font-size:12px;color:' + C.muted + '">Report · ' + esc(d.date || "") + (d.platform ? " · " + esc(d.platform) : "") + '</div><div style="margin-top:10px;font-family:' + F + ';font-size:30px;line-height:36px;letter-spacing:-.03em;color:' + C.text + '">Your performance report for <span style="color:#A68EFA">' + site + "</span></div>" +
      (!print ? intro(d, site, sc, up) : '<div style="margin-top:14px;font-family:' + F + ';font-size:15.5px;line-height:24px;color:' + C.text2 + '">Everything holding ' + site + " back, with the fixes ranked by what they cost you.</div>") + "</td></tr>";
    rows += '<tr><td style="padding:18px 18px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
      scoreTile(sc.perf, "Performance", sc.desk != null ? "desktop " + sc.desk : "phone", base) + scoreTile(sc.search, "Search", sc.searchN ? sc.searchN + " checks" : "", base) + scoreTile(sc.ai, "AI answers", sc.aiN ? sc.aiN + " checks" : "", base) +
      "</tr></table></td></tr>";
    if (up && sc.perf != null) {
      rows += card('<div style="font-family:' + M + ';font-size:11.5px;color:' + C.lilac + '">Overall performance score · Google PageSpeed, phone</div><div style="margin-top:8px;font-family:' + F + ';font-size:22px;line-height:29px;letter-spacing:-.02em;color:' + C.text + '">See ' + site + ' go from <span style="color:' + band(sc.perf) + '">' + sc.perf + '</span> to <span style="color:' + C.lilac + '">' + up.target + "</span>.</div>" +
        '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr><td style="padding:8px 14px;border:1px solid #4A3D86;border-radius:10px;background:#1E1838;font-family:' + M + ';font-size:18px;color:' + C.lilac + '">+' + up.conv + '% <span style="font-family:' + F + ';font-size:13px;color:' + C.text2 + '">conversions</span></td><td width="10"></td><td style="padding:8px 14px;border:1px solid #275C45;border-radius:10px;background:#122A20;font-family:' + M + ';font-size:18px;color:#9FE3C1">+' + up.rev + '% <span style="font-family:' + F + ';font-size:13px;color:' + C.text2 + '">revenue</span></td></tr></table>' +
        '<div style="margin-top:12px;font-family:' + F + ';font-size:12px;line-height:18px;color:' + C.dim + '">Google found that when a site meets its Core Web Vitals, shoppers are 24% less likely to abandon the page while it loads (Chromium blog, 2020). Uplift is an estimate from a billion-dollar house of brands case and Deloitte × Google. Same traffic. Not a guarantee.</div>', "22px 22px 20px");
    }

    // Core Web Vitals
    if (d.vitals && d.vitals.length) {
      rows += '<tr><td style="' + pb + 'padding:0"></td></tr>' + rule(base) + h2("Performance · phone test", "What your shoppers", "actually wait through");
      rows += card('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' +
        '<tr><td style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Metric</td><td align="right" style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Your page</td><td align="right" style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Google’s good line</td></tr>' +
        d.vitals.map(function (v) {
          return '<tr><td style="padding:11px 0;border-top:1px solid ' + C.line + ';font-family:' + F + ';font-size:14.5px;color:' + C.text + '">' + esc(v.name) + '<div style="font-family:' + M + ';font-size:10.5px;color:' + C.dim + '">' + esc(v.abbr) + "</div></td>" +
            '<td align="right" style="padding:11px 0;border-top:1px solid ' + C.line + ';font-family:' + M + ';font-size:16px;color:' + kcol(v.kind) + '">' + esc(v.value) + "<br>" + pill(kname(v.kind), kcol(v.kind)) + "</td>" +
            '<td align="right" style="padding:11px 0;border-top:1px solid ' + C.line + ';font-family:' + M + ';font-size:12.5px;color:' + C.muted + '">' + esc(v.good) + "</td></tr>";
        }).join("") + "</table>" + (d.cwv != null ? '<div style="margin-top:12px">' + pill("Core Web Vitals: " + (d.cwv ? "passed" : "failed"), d.cwv ? C.good : C.bad) + "</div>" : ""));
    }

    // app tax
    if (d.apps && d.apps.length) {
      var mx = Math.max.apply(null, d.apps.map(function (a) { return a.ms || 1; }).concat([1]));
      rows += h2("App tax", "What third-party apps", "cost a shopper");
      rows += card('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + d.apps.map(function (a) {
        var w = Math.max(3, Math.round(a.ms / mx * 100)), col = a.ms >= 500 ? C.bad : a.ms >= 150 ? C.warn : "#8B8BA0";
        return '<tr><td style="padding:8px 0;font-family:' + F + ';font-size:14px;color:' + C.text + '">' + esc(a.name) + '</td><td align="right" style="padding:8px 0;font-family:' + M + ';font-size:12.5px;color:' + C.muted + '">' + Math.round(a.ms) + ' ms</td></tr><tr><td colspan="2" style="padding:0 0 6px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#22202C;border-radius:4px"><tr><td width="' + w + '%" height="6" style="background:' + col + ';border-radius:4px;font-size:0;line-height:0">&nbsp;</td><td style="font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr>';
      }).join("") + "</table>");
    }

    // fix plan
    if (d.fixes && d.fixes.length) {
      rows += '<tr><td style="' + pb + 'padding:0"></td></tr>' + rule(base) + h2("Your fix plan", "Fix these", "first");
      rows += card(d.fixes.map(function (x, i) {
        var tc = x.tag === "Performance" ? C.lilac : x.tag === "Search" ? "#9FE3C1" : "#7FD1C7";
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"' + (i ? ' style="border-top:1px solid ' + C.line + '"' : "") + '><tr><td valign="top" width="40" style="padding:14px 0;font-family:' + M + ';font-size:15px;color:#A68EFA">' + (i < 9 ? "0" : "") + (i + 1) + '</td><td valign="top" style="padding:14px 0">' +
          '<div>' + pill(x.tag, tc) + " " + (x.effort ? pill(x.effort, C.muted) : "") + "</div>" +
          '<div style="margin-top:8px;font-family:' + F + ';font-size:15.5px;line-height:21px;color:' + C.text + '">' + esc(x.title) + "</div>" +
          '<div style="margin-top:4px;font-family:' + F + ';font-size:13px;line-height:19px;color:' + C.muted + '">' + esc(x.why) + "</div>" +
          '<div style="margin-top:6px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Impact <span style="color:' + C.text2 + '">' + esc(x.imp || "minor") + '</span> · Who fixes it <span style="color:' + C.text2 + '">' + esc(x.who || "Developer") + "</span></div></td></tr></table>";
      }).join(""), "4px 22px");
    }

    // search + AI
    if (d.search && d.search.length) {
      var sFail = d.search.filter(function (c) { return c.status !== "pass"; }), sPass = d.search.length - sFail.length;
      rows += '<tr><td style="' + pb + 'padding:0"></td></tr>' + rule(base) + h2("Search · score " + (sc.search == null ? "–" : sc.search) + "/100", "How Google", "sees your site");
      rows += card('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + checkRows(sFail) + "</table>" + '<div style="margin-top:10px;font-family:' + M + ';font-size:11.5px;color:' + C.good + '">✓ ' + sPass + " checks passed</div>");
    }
    if (d.ai && d.ai.length) {
      var aFail = d.ai.filter(function (c) { return c.status !== "pass"; }), aPass = d.ai.length - aFail.length;
      rows += rule(base) + h2("AI answers · score " + (sc.ai == null ? "–" : sc.ai) + "/100", "See if ChatGPT", "recommends you");
      rows += card('<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + checkRows(aFail) + "</table>" + '<div style="margin-top:10px;font-family:' + M + ';font-size:11.5px;color:' + C.good + '">✓ ' + aPass + " checks passed</div>" +
        (d.bots && d.bots.length ? '<div style="margin-top:12px;font-family:' + F + ';font-size:13px;color:' + C.text2 + '">AI crawlers your robots.txt blocks: <span style="color:' + C.bad + '">' + esc(d.bots.join(", ")) + "</span></div>" : ""));
    }

    // competitors
    if (d.comps && d.comps.length > 1) {
      var me = 0; d.comps.forEach(function (c, i) { if (c.you) me = i; });
      rows += '<tr><td style="' + pb + 'padding:0"></td></tr>' + rule(base) + h2(d.compsAuto ? "Auto-picked rivals · same phone test" : "Phone test · same moment", "You vs", "your competitors");
      rows += card('<div style="font-family:' + F + ';font-size:20px;color:' + C.text + '">You rank <span style="color:#A68EFA">#' + (me + 1) + "</span> of " + d.comps.length + "</div>" +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr><td style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Brand</td><td align="right" style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Score</td><td align="right" style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">Speed Index</td><td align="right" style="padding:0 0 8px;font-family:' + M + ';font-size:11px;color:' + C.dim + '">LCP</td></tr>' +
        d.comps.map(function (c, i) {
          var bg = c.you ? "background:#1E1838;" : "";
          return '<tr><td style="' + bg + 'padding:10px 6px;border-top:1px solid ' + C.line + ';font-family:' + F + ';font-size:14px;color:' + C.text + '"><span style="font-family:' + M + ';color:#A68EFA">' + (i + 1) + "</span> &nbsp;" + esc(c.site) + (c.you ? ' <span style="font-family:' + M + ';font-size:10.5px;color:' + C.lilac + '">YOU</span>' : "") + "</td>" +
            '<td align="right" style="' + bg + 'padding:10px 6px;border-top:1px solid ' + C.line + ';font-family:' + M + ';font-size:15px;color:' + band(c.perf) + '">' + (c.perf == null ? "–" : c.perf) + "</td>" +
            '<td align="right" style="' + bg + 'padding:10px 6px;border-top:1px solid ' + C.line + ';font-family:' + M + ';font-size:12.5px;color:' + C.text2 + '">' + esc(c.si || "–") + "</td>" +
            '<td align="right" style="' + bg + 'padding:10px 6px;border-top:1px solid ' + C.line + ';font-family:' + M + ';font-size:12.5px;color:' + C.text2 + '">' + esc(c.lcp || "–") + "</td></tr>";
        }).join("") + "</table>");
    }

    // CTA
    rows += rule(base) + '<tr><td style="padding:30px 24px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1B1532;border:1px solid #4A3D86;border-radius:18px"><tr><td align="center" style="padding:32px 24px">' +
      '<div style="font-family:' + F + ';font-size:26px;line-height:32px;letter-spacing:-.02em;color:' + C.text + '">Want your site fixed?</div><div style="margin-top:8px;font-family:' + F + ';font-size:15px;line-height:22px;color:' + C.text2 + '">Get every fix built and tested on your site: speed, SEO and AI answers.</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px auto 0"><tr><td style="border-radius:10px;background:' + C.purple + '"><a href="' + esc(d.demoUrl || "https://calendly.com/nj-troopod/troopod-demo") + '" style="display:inline-block;padding:13px 22px;font-family:' + F + ';font-size:15px;font-weight:500;color:#FFFFFF;text-decoration:none">Book a demo</a></td>' +
      (d.reportUrl && !print ? '<td width="10"></td><td style="border-radius:10px;border:1px solid #4A3D86"><a href="' + esc(d.reportUrl) + '" style="display:inline-block;padding:12px 18px;font-family:' + F + ';font-size:15px;color:' + C.text + ';text-decoration:none">Open live report</a></td>' : "") +
      "</tr></table></td></tr></table></td></tr>";
    // footer
    rows += '<tr><td style="padding:24px 32px 34px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td valign="middle"><img src="' + base + 'assets/email/troopod-mark-white.png" width="20" height="20" alt="Troopod" style="display:block;width:20px;height:auto;border:0;opacity:.85"></td><td valign="middle" style="padding-left:9px;font-family:' + F + ';font-size:13.5px;color:' + C.text2 + '">Troo<span style="color:#A68EFA">Performance</span> · a Troopod company</td></tr></table>' +
      '<div style="margin-top:12px;font-family:' + F + ';font-size:11.5px;line-height:17px;color:' + C.dim + '">Speed comes from Google PageSpeed Insights (Lighthouse on an emulated phone, plus Chrome real-user data where Google has enough visits). Search and AI checks read your page’s raw HTML, robots.txt, sitemap and llms.txt. Scores: pass = 1, warning = 0.5, fail = 0, out of 100.' +
      (print ? "" : " You’re getting this because you unlocked your report on TrooPerformance. Reply to this email to talk to the team.") + "</div></td></tr>";

    var table = '<table class="doc" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:' + C.bg + ';border:1px solid #1F1C2B;border-radius:' + (print ? "0" : "20px") + ';overflow:hidden">' + rows + "</table>";
    var pre = esc("Performance " + (sc.perf == null ? "–" : sc.perf) + " · Search " + (sc.search == null ? "–" : sc.search) + " · AI answers " + (sc.ai == null ? "–" : sc.ai) + ". Your fix plan for " + d.site + " is inside.");
    var head = '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><meta name="supported-color-schemes" content="dark light"><title>TrooPerformance report · ' + site + "</title>" +
      '<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500&display=swap" rel="stylesheet">' +
      (print ? "<style>@page{size:A4;margin:0}html,body{margin:0;background:" + C.bg + ";-webkit-print-color-adjust:exact;print-color-adjust:exact}table{break-inside:auto}tr{break-inside:avoid}.wrap{padding:0}.doc{border:0!important}@media print{.doc{zoom:1.14}}@media screen{body{padding:24px 0}}</style>" : "<style>@media (max-width:620px){.wrap{padding:0!important}}</style>");
    return "<!doctype html><html lang=\"en\"><head>" + head + '</head><body style="margin:0;padding:0;background:' + C.bg + '">' +
      (print ? "" : '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + pre + "</div>") +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:' + C.bg + '"><tr><td align="center" class="wrap" style="padding:' + (print ? "0" : "24px 12px") + '">' + table + "</td></tr></table></body></html>";
  }

  root.TPReportDoc = { render: render, subject: function (d) { return "Your TrooPerformance report for " + d.site + ": performance " + (d.scores && d.scores.perf != null ? d.scores.perf : "–") + "/100"; } };
})(typeof window !== "undefined" ? window : globalThis);
