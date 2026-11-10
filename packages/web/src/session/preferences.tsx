/**
 * Theme and language: what is chosen, how it is applied, and how it is saved.
 *
 * Both are remembered in the browser (so the page can be right before the
 * session loads) and saved to the server with PATCH /api/me (so they follow
 * the person to other devices). When the session loads, the server's values win.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Locale, PreferencesPatch, Session, Theme, User } from "@hearth/shared";
import { createTranslator, type Translate } from "../i18n";
import { applyLocale, initialLocale, otherLocale, storeLocale } from "../i18n/locale";
import {
  applyTheme,
  readStoredTheme,
  resolveTheme,
  storeTheme,
  systemPrefersDark,
  toggledTheme,
  watchSystemTheme,
  type ResolvedTheme,
} from "../theme/theme";
import { patchPreferences } from "./api";
import { SESSION_QUERY_KEY } from "./session";

type Preferences = {
  /** What the person chose. */
  theme: Theme;
  /** What is on screen. */
  resolvedTheme: ResolvedTheme;
  locale: Locale;
  t: Translate;
  setTheme: (theme: Theme) => void;
  /** Switches between light and dark, starting from what is on screen. */
  toggleTheme: () => void;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  /** Saves the person's name. Rejects if the server refuses. */
  saveName: (name: string) => Promise<void>;
  /** Takes the server's stored choices as the current ones, without saving them back. */
  adopt: (user: Pick<User, "theme" | "locale">) => void;
  /** True when a theme or language change did not reach the server. */
  saveFailed: boolean;
  retrySave: () => void;
  dismissSaveFailure: () => void;
};

const PreferencesContext = createContext<Preferences | null>(null);

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const subscribeToSystemTheme = (onChange: () => void) => watchSystemTheme(window, onChange);
const getSystemDark = () => systemPrefersDark(window);

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme(storage()) ?? "system");
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale(storage(), navigator.languages));
  const [unsaved, setUnsaved] = useState<PreferencesPatch | null>(null);

  const systemDark = useSyncExternalStore(subscribeToSystemTheme, getSystemDark, () => false);
  const resolvedTheme = resolveTheme(theme, systemDark);

  useEffect(() => applyTheme(document, resolvedTheme), [resolvedTheme]);
  useEffect(() => applyLocale(document, locale), [locale]);

  /** Sends a change to the server, if there is a session to save it to, and mirrors it in the cached session. */
  const send = useCallback(
    async (patch: PreferencesPatch) => {
      if (!queryClient.getQueryData<Session>(SESSION_QUERY_KEY)) return;
      queryClient.setQueryData<Session>(SESSION_QUERY_KEY, (session) =>
        session ? { ...session, user: { ...session.user, ...patch } } : session,
      );
      await patchPreferences(patch);
    },
    [queryClient],
  );

  const sendQuietly = useCallback(
    (patch: PreferencesPatch) => {
      send(patch).then(
        // Saved: forget any earlier failure for the same settings, keep the rest.
        () =>
          setUnsaved((previous) => {
            if (!previous) return null;
            const rest = Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in patch)));
            return Object.keys(rest).length > 0 ? (rest as PreferencesPatch) : null;
          }),
        () => setUnsaved((previous) => ({ ...previous, ...patch })),
      );
    },
    [send],
  );

  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      storeTheme(storage(), next);
      sendQuietly({ theme: next });
    },
    [sendQuietly],
  );

  const setLocale = useCallback(
    (next: Locale) => {
      setLocaleState(next);
      storeLocale(storage(), next);
      sendQuietly({ locale: next });
    },
    [sendQuietly],
  );

  const saveName = useCallback(
    async (name: string) => {
      const before = queryClient.getQueryData<Session>(SESSION_QUERY_KEY)?.user.name;
      try {
        await send({ name });
      } catch (error) {
        if (before !== undefined) {
          queryClient.setQueryData<Session>(SESSION_QUERY_KEY, (session) =>
            session ? { ...session, user: { ...session.user, name: before } } : session,
          );
        }
        throw error;
      }
    },
    [queryClient, send],
  );

  const adopt = useCallback((user: Pick<User, "theme" | "locale">) => {
    setThemeState(user.theme);
    storeTheme(storage(), user.theme);
    setLocaleState(user.locale);
    storeLocale(storage(), user.locale);
  }, []);

  const value = useMemo<Preferences>(
    () => ({
      theme,
      resolvedTheme,
      locale,
      t: createTranslator(locale),
      setTheme,
      toggleTheme: () => setTheme(toggledTheme(resolvedTheme)),
      setLocale,
      toggleLocale: () => setLocale(otherLocale(locale)),
      saveName,
      adopt,
      saveFailed: unsaved !== null,
      retrySave: () => {
        if (unsaved) sendQuietly(unsaved);
      },
      dismissSaveFailure: () => setUnsaved(null),
    }),
    [theme, resolvedTheme, locale, setTheme, setLocale, saveName, adopt, unsaved, sendQuietly],
  );

  return <PreferencesContext value={value}>{children}</PreferencesContext>;
}

export function usePreferences(): Preferences {
  const preferences = useContext(PreferencesContext);
  if (!preferences) throw new Error("usePreferences must be used inside <PreferencesProvider>");
  return preferences;
}

/** The current language and its `t` function. */
export function useI18n(): Pick<Preferences, "locale" | "t"> {
  const { locale, t } = usePreferences();
  return { locale, t };
}
