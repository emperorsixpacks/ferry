import { useSyncExternalStore } from "react";

// Light or dark. The choice is "system" (follow prefers-color-scheme, the default), "light" or
// "dark"; an explicit one is remembered in localStorage under ferry-theme, which /theme.js reads
// before the first paint. From then on this module keeps the page in step: with the system while
// the choice is "system", and with other tabs. The theme is the `dark` class on <html>
// (index.css), with data-theme and color-scheme to match.

export type ThemeChoice = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "ferry-theme";
const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function stored(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const resolve = (c: ThemeChoice): Theme => (c === "system" ? (media?.matches ? "dark" : "light") : c);

let snapshot: { choice: ThemeChoice; theme: Theme } = { choice: stored(), theme: "light" };
snapshot.theme = resolve(snapshot.choice);
const listeners = new Set<() => void>();

function paint(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}
// /theme.js has done this already; again here in case it didn't run
paint(snapshot.theme);

function update(choice: ThemeChoice) {
  const theme = resolve(choice);
  if (theme !== snapshot.theme) {
    // every colour changes at once: nothing runs its own colour transition across the switch
    const root = document.documentElement;
    root.classList.add("theme-switching");
    paint(theme);
    void root.offsetHeight;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  if (choice !== snapshot.choice || theme !== snapshot.theme) {
    snapshot = { choice, theme };
    listeners.forEach((f) => f());
  }
}

media?.addEventListener("change", () => update(snapshot.choice));
// another tab made a choice
window.addEventListener("storage", (e) => {
  if (e.key === KEY || e.key === null) update(stored());
});

export function setThemeChoice(choice: ThemeChoice) {
  try {
    if (choice === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // no storage (a private window, blocked site data): the choice lasts until the page closes
  }
  update(choice);
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

// The choice and the theme it comes to; a component using it re-renders when either changes.
export function useTheme() {
  const s = useSyncExternalStore(subscribe, () => snapshot);
  return { ...s, setChoice: setThemeChoice };
}

// for code outside React's render: the landing's canvas repaints on a change
export const currentTheme = () => snapshot.theme;
export const onThemeChange = subscribe;
