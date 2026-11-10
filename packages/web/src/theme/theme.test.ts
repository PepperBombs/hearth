import { afterEach, describe, expect, it, vi } from "vitest";
import themeInit from "../../public/theme-init.js?raw";
import {
  DARK_QUERY,
  THEME_COLORS,
  THEME_STORAGE_KEY,
  applyTheme,
  isTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
  toggledTheme,
  watchSystemTheme,
} from "./theme";

/** A stand-in for window.matchMedia whose answer can be changed, as when the device switches to dark. */
function fakeMatchMedia(initiallyDark: boolean) {
  let dark = initiallyDark;
  const listeners = new Set<() => void>();
  const matchMedia = (query: string) =>
    ({
      media: query,
      get matches() {
        return query === DARK_QUERY ? dark : false;
      },
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }) as unknown as MediaQueryList;
  return {
    matchMedia,
    setDark(next: boolean) {
      dark = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

function addThemeColorMeta(): HTMLMetaElement {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.content = "#ffffff";
  document.head.append(meta);
  return meta;
}

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("keeps an explicit choice whatever the device says", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the device for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("toggledTheme", () => {
  it("switches to the opposite of what is on screen", () => {
    expect(toggledTheme("light")).toBe("dark");
    expect(toggledTheme("dark")).toBe("light");
    // From "system" on a dark device the toggle goes to light, not to dark.
    expect(toggledTheme(resolveTheme("system", true))).toBe("light");
  });
});

describe("stored theme", () => {
  it("accepts only the three themes", () => {
    expect(isTheme("light")).toBe(true);
    expect(isTheme("dark")).toBe(true);
    expect(isTheme("system")).toBe(true);
    expect(isTheme("sepia")).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it("round-trips through storage", () => {
    expect(readStoredTheme(window.localStorage)).toBeNull();
    storeTheme(window.localStorage, "dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(readStoredTheme(window.localStorage)).toBe("dark");
  });

  it("ignores junk and survives blocked storage", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readStoredTheme(window.localStorage)).toBeNull();
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredTheme(blocked)).toBeNull();
    expect(() => storeTheme(blocked, "dark")).not.toThrow();
    expect(readStoredTheme(undefined)).toBeNull();
  });
});

describe("applyTheme", () => {
  it("sets the attribute the tokens key off and the browser chrome colour", () => {
    const meta = addThemeColorMeta();
    applyTheme(document, "dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(meta.content).toBe(THEME_COLORS.dark);
    applyTheme(document, "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(meta.content).toBe(THEME_COLORS.light);
  });

  it("works without the meta tag", () => {
    expect(() => applyTheme(document, "dark")).not.toThrow();
  });
});

describe("system theme", () => {
  it("reads the device setting", () => {
    expect(systemPrefersDark(fakeMatchMedia(true))).toBe(true);
    expect(systemPrefersDark(fakeMatchMedia(false))).toBe(false);
    expect(systemPrefersDark(undefined)).toBe(false);
  });

  it("calls back when the device switches, until unsubscribed", () => {
    const media = fakeMatchMedia(false);
    const onChange = vi.fn();
    const stop = watchSystemTheme(media, onChange);
    media.setDark(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(systemPrefersDark(media)).toBe(true);
    stop();
    expect(media.listenerCount()).toBe(0);
    media.setDark(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("public/theme-init.js (runs before first paint)", () => {
  /** Runs the script the way the browser does, as a plain script against the current document. */
  const runInit = () => new Function(themeInit)();

  const cases = [
    { stored: null, systemDark: false },
    { stored: null, systemDark: true },
    { stored: "light", systemDark: true },
    { stored: "dark", systemDark: false },
    { stored: "system", systemDark: true },
    { stored: "system", systemDark: false },
    { stored: "sepia", systemDark: true },
  ] as const;

  it.each(cases)("agrees with resolveTheme for stored=$stored systemDark=$systemDark", ({ stored, systemDark }) => {
    if (stored) window.localStorage.setItem(THEME_STORAGE_KEY, stored);
    vi.stubGlobal("matchMedia", fakeMatchMedia(systemDark).matchMedia);
    const meta = addThemeColorMeta();

    runInit();

    const expected = resolveTheme(readStoredTheme(window.localStorage) ?? "system", systemDark);
    expect(document.documentElement.getAttribute("data-theme")).toBe(expected);
    expect(meta.content).toBe(THEME_COLORS[expected]);
  });

  it("applies the remembered language", () => {
    window.localStorage.setItem("hearth.locale", "zh");
    runInit();
    expect(document.documentElement.lang).toBe("zh-Hans");
    window.localStorage.setItem("hearth.locale", "en");
    runInit();
    expect(document.documentElement.lang).toBe("en");
  });

  it("falls back to the browser language when none is remembered", () => {
    vi.stubGlobal("navigator", { languages: ["zh-CN", "en"], language: "zh-CN" });
    runInit();
    expect(document.documentElement.lang).toBe("zh-Hans");
  });
});
