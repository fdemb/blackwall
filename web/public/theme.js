(function () {
  try {
    var theme = localStorage.getItem("bw-theme") || "system";
    var dark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.lang = localStorage.getItem("bw-lang") || "en";
  } catch (e) {}
})();
