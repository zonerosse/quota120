/* Protezione anti-robot di Cloudflare (Turnstile) sui moduli che mandano un codice via email.
   Mette il riquadro dentro ogni .ts-box; tsToken() dà il gettone da mandare, tsReset() lo rinnova. */
(function () {
  var CHIAVE = "__SITEKEY__", ids = [], tok = "";
  window.tsToken = function () { return tok; };
  window.tsReset = function () { tok = ""; try { ids.forEach(function (i) { turnstile.reset(i); }); } catch (e) {} };
  window.tsPronto = function () {
    document.querySelectorAll(".ts-box").forEach(function (el) {
      ids.push(turnstile.render(el, { sitekey: CHIAVE, language: "it", theme: "light", size: "flexible",
        callback: function (t) { tok = t; }, "expired-callback": function () { tok = ""; }, "error-callback": function () { tok = ""; } }));
    });
  };
  var s = document.createElement("script");
  s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=tsPronto"; s.async = true; s.defer = true;
  document.head.appendChild(s);
})();
