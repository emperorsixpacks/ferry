// Ferry's theme, set before the first paint so a dark page never flashes white (or the other way
// round). index.html loads this file as a plain blocking script in <head>: prod's CSP allows only
// 'self' scripts, so it can't be inline. The choice is "light" or "dark" in localStorage
// (ferry-theme), else the system's preference; app/lib/theme.ts takes over once the app runs.
(function () {
  var choice = null;
  try {
    choice = window.localStorage.getItem("ferry-theme");
  } catch (e) {}
  var dark = choice === "dark" || (choice !== "light" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  if (dark) root.classList.add("dark");
  else root.classList.remove("dark");
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.style.colorScheme = dark ? "dark" : "light";
})();
