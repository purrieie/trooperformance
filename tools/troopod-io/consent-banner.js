/* Opt-in cookie banner for /trooperformance (Indian traffic: nothing optional runs until the visitor taps Accept).
   Same cookie, Google Consent Mode update and Meta Pixel gate as the main troopod.io banner (src/lib/cookieConsent.ts),
   so a choice made here or on troopod.io carries over both ways. The <head> of each page sets consent to "denied"
   by default and loads Meta Pixel when "troopod-consent-granted" fires. */
(function () {
  "use strict";
  var NAME = "troopod_cookie_consent", MAX_AGE = 60 * 60 * 24 * 365;

  function read() {
    var m = document.cookie.match(new RegExp("(?:^|; )" + NAME + "=([^;]*)"));
    var v = m ? decodeURIComponent(m[1]) : null;
    return v === "accepted" || v === "rejected" ? v : null;
  }
  function write(v) {
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = NAME + "=" + v + "; path=/; max-age=" + MAX_AGE + "; SameSite=Lax" + secure;
  }
  function decide(v) {
    write(v);
    var g = v === "accepted" ? "granted" : "denied";
    if (typeof window.gtag === "function") window.gtag("consent", "update", { analytics_storage: g, ad_storage: g, ad_user_data: g, ad_personalization: g });
    if (v === "accepted") window.dispatchEvent(new Event("troopod-consent-granted"));
    else { document.cookie = "_fbp=; path=/; max-age=0"; document.cookie = "_fbc=; path=/; max-age=0"; }
  }

  if (read()) return; // already chose here or on troopod.io

  function show() {
    var css = document.createElement("style");
    css.textContent =
      ".tp-ck{position:fixed;left:0;right:0;bottom:0;z-index:100;background:rgba(14,14,18,.96);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);border-top:1px solid rgba(255,255,255,.14);color:#CFCCD9;font:14px/1.5 'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif}" +
      ".tp-ck-in{max-width:1120px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}" +
      ".tp-ck p{margin:0}.tp-ck a{color:#A68EFA;text-decoration:underline;text-underline-offset:3px}" +
      ".tp-ck-b{display:flex;gap:10px}.tp-ck button{flex:1;min-height:44px;padding:0 18px;border-radius:10px;font:500 15px 'DM Sans',system-ui,sans-serif;cursor:pointer}" +
      ".tp-ck .no{background:transparent;color:#F4F3F8;border:1px solid rgba(255,255,255,.22)}.tp-ck .yes{background:#8B6BF7;color:#fff;border:1px solid #8B6BF7}" +
      ".tp-ck button:focus-visible{outline:2px solid #CBBEFD;outline-offset:2px}" +
      "@media(min-width:768px){.tp-ck-in{flex-direction:row;align-items:center;justify-content:space-between;gap:32px;padding:18px 32px}.tp-ck-b{flex:none}.tp-ck button{flex:none}}";
    document.head.appendChild(css);
    var box = document.createElement("div");
    box.className = "tp-ck";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-live", "polite");
    box.setAttribute("aria-label", "Cookie consent");
    box.innerHTML = '<div class="tp-ck-in"><p>We use cookies to keep Troopod running smoothly and to understand how visitors use our site through analytics and tracking. You can accept all cookies or reject the optional ones. <a href="/privacy">Privacy Policy</a></p>' +
      '<div class="tp-ck-b"><button type="button" class="no" data-ck="rejected">Reject</button><button type="button" class="yes" data-ck="accepted">Accept</button></div></div>';
    box.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-ck]"); if (!b) return;
      decide(b.getAttribute("data-ck"));
      box.remove();
    });
    document.body.appendChild(box);
  }
  if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
})();
