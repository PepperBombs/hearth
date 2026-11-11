/*
 * Runs before first paint, as a plain blocking script.
 * Applies the remembered theme and language so the page does not flash.
 * Keep in step with src/theme/theme.ts and src/i18n/locale.ts (a unit test runs this file against them).
 */
(function () {
  var root = document.documentElement;
  var theme = "system";
  var locale = null;
  try {
    var storedTheme = window.localStorage.getItem("hearth.theme");
    if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") theme = storedTheme;
    var storedLocale = window.localStorage.getItem("hearth.locale");
    if (storedLocale === "en" || storedLocale === "zh") locale = storedLocale;
  } catch (error) {
    /* Storage can be blocked. Fall back to the device setting. */
  }
  var systemDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var dark = theme === "dark" || (theme === "system" && systemDark);
  root.setAttribute("data-theme", dark ? "dark" : "light");
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#1a2029" : "#ffffff");
  if (!locale) {
    var preferred = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
    locale = /^zh\b/i.test(preferred) ? "zh" : "en";
  }
  root.setAttribute("lang", locale === "zh" ? "zh-Hans" : "en");
})();
