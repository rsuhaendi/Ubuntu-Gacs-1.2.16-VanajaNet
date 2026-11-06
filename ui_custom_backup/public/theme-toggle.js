// GenieACS Theme Toggle - vanilla, tahan re-render Mithril
(function () {
  var KEY = "genieacs-theme";
  var DEFAULT = "dark";
  function theme() {
    try { return localStorage.getItem(KEY) || DEFAULT; } catch (e) { return DEFAULT; }
  }
  function apply(t) {
    try { document.documentElement.dataset.theme = t; } catch (e) {}
    try { localStorage.setItem(KEY, t); } catch (e) {}
    var btn = document.querySelector(".theme-toggle-btn");
    if (btn) {
      btn.textContent = (t === "dark") ? "\u2600\uFE0F" : "\uD83C\uDF19";
      btn.title = (t === "dark") ? "Berpindah ke Light Mode" : "Berpindah ke Dark Mode";
      btn.setAttribute("aria-label", btn.title);
    }
  }
  function ensureButton() {
    var host = document.querySelector(".user-menu");
    if (!host) return;
    if (host.querySelector(".theme-toggle-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle-btn";
    var t = theme();
    btn.textContent = (t === "dark") ? "\u2600\uFE0F" : "\uD83C\uDF19";
    btn.title = (t === "dark") ? "Berpindah ke Light Mode" : "Berpindah ke Dark Mode";
    btn.setAttribute("aria-label", btn.title);
    btn.onclick = function () {
      apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    };
    host.insertBefore(btn, host.firstChild);
  }
  function init() {
    apply(document.documentElement.dataset.theme || theme());
    ensureButton();
    var obs = new MutationObserver(ensureButton);
    try { obs.observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
  setInterval(ensureButton, 1000);
})();
