(function () {
  try {
    var theme = localStorage.getItem("bw-theme:v1") || "system";
    var dark =
      theme === "dark" ||
      (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    var lang = localStorage.getItem("bw-lang:v1");
    if (lang !== "en" && lang !== "pl")
      lang = navigator.language && navigator.language.indexOf("pl") === 0 ? "pl" : "en";
    document.documentElement.lang = lang;
  } catch {}
})();
