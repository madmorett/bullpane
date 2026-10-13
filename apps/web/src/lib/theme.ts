/**
 * Per-browser theme choice. index.html applies the stored choice before the
 * first paint; this module keeps it in sync afterwards (settings toggle, OS
 * switching between light and dark while "system" is selected).
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "bullpane.theme";
const osLight = window.matchMedia("(prefers-color-scheme: light)");

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    // storage blocked (private mode, policies): fall back to the OS
  }
  return "system";
}

export function applyTheme(pref: ThemePref = getThemePref()) {
  const light = pref === "light" || (pref === "system" && osLight.matches);
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // not persisted, still applied for this page
  }
  applyTheme(pref);
}

osLight.addEventListener("change", () => applyTheme());
