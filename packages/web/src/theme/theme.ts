/**
 * Theme logic, kept free of React so it can be tested on its own.
 * A preference is "light", "dark" or "system"; what is shown is always
 * "light" or "dark". public/theme-init.js applies the same rules before first paint.
 */
import { THEMES, type Theme } from "@hearth/shared";

export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "hearth.theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Browser chrome colour per theme: the top bar's surface. */
export const THEME_COLORS: Readonly<Record<ResolvedTheme, string>> = { light: "#ffffff", dark: "#1a2029" };

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function resolveTheme(preference: Theme, systemDark: boolean): ResolvedTheme {
  if (preference === "system") return systemDark ? "dark" : "light";
  return preference;
}

/** What the light/dark toggle switches to: the opposite of what is on screen now. */
export function toggledTheme(resolved: ResolvedTheme): ResolvedTheme {
  return resolved === "dark" ? "light" : "dark";
}

export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined): Theme | null {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isTheme(value) ? value : null;
  } catch {
    return null;
  }
}

export function storeTheme(storage: Pick<Storage, "setItem"> | undefined, theme: Theme): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* Storage can be blocked; the choice then lasts for this visit only. */
  }
}

/** Puts the theme on the page: the attribute the tokens key off, and the browser chrome colour. */
export function applyTheme(doc: Document, resolved: ResolvedTheme): void {
  doc.documentElement.setAttribute("data-theme", resolved);
  doc.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[resolved]);
}

/** Whether the device currently asks for dark. False where the question cannot be asked. */
export function systemPrefersDark(win: Pick<Window, "matchMedia"> | undefined): boolean {
  return win?.matchMedia?.(DARK_QUERY).matches ?? false;
}

/** Calls back whenever the device switches between light and dark. Returns the unsubscribe function. */
export function watchSystemTheme(win: Pick<Window, "matchMedia"> | undefined, onChange: () => void): () => void {
  const query = win?.matchMedia?.(DARK_QUERY);
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
