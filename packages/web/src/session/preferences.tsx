/**
 * Theme and language: what is chosen, how it is applied, and how it is saved.
 *
 * Both are remembered in the browser (so the page can be right before the
 * session loads) and saved to the server with PATCH /api/me (so they follow
 * the person to other devices). When the session loads, the server's values
 * win, except over a choice made here that the server never received: that
 * one is kept and sent again (see unsaved.ts).
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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
import { forgetUnsaved, noteUnsaved, readUnsaved, type UnsavedChoices } from "./unsaved";

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
  /**
   * Takes the server's stored choices as the current ones, without saving
   * them back. A choice made here that never reached the server is kept
   * instead, and sent now.
   */
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
  /** Choices whose save failed during this visit: what the banner is about. */
  const [unsaved, setUnsaved] = useState<UnsavedChoices | null>(null);
  /** How many theme or language saves are on their way. */
  const sending = useRef(0);

  const systemDark = useSyncExternalStore(subscribeToSystemTheme, getSystemDark, () => false);
  const resolvedTheme = resolveTheme(theme, systemDark);

  useEffect(() => applyTheme(document, resolvedTheme), [resolvedTheme]);
  useEffect(() => applyLocale(document, locale), [locale]);

  /** Puts a change into the cached session, so everything that reads the session shows it. */
  const mirror = useCallback(
    (patch: PreferencesPatch) => {
      queryClient.setQueryData<Session>(SESSION_QUERY_KEY, (session) =>
        session ? { ...session, user: { ...session.user, ...patch } } : session,
      );
    },
    [queryClient],
  );

  /**
   * Saves a theme or language choice in the background. The choice is noted
   * in the browser until the server has it, so a failed save, or a choice
   * made before there is a session to save it to, is not lost on a reload.
   */
  const sendQuietly = useCallback(
    (patch: UnsavedChoices) => {
      noteUnsaved(storage(), patch);
      if (!queryClient.getQueryData<Session>(SESSION_QUERY_KEY)) return;
      mirror(patch);
      sending.current += 1;
      patchPreferences(patch)
        .then(
          () => {
            forgetUnsaved(storage(), patch);
            // Forget any earlier failure for the same settings, keep the rest.
            setUnsaved((previous) => {
              if (!previous) return null;
              const rest = Object.fromEntries(Object.entries(previous).filter(([key]) => !(key in patch)));
              return Object.keys(rest).length > 0 ? (rest as UnsavedChoices) : null;
            });
          },
          () => setUnsaved((previous) => ({ ...previous, ...patch })),
        )
        .finally(() => {
          sending.current -= 1;
        });
    },
    [queryClient, mirror],
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

  // The name shown everywhere is the saved one: it changes only once the
  // server has accepted it, so a failed save has nothing to undo.
  const saveName = useCallback(
    async (name: string) => {
      if (!queryClient.getQueryData<Session>(SESSION_QUERY_KEY)) return;
      await patchPreferences({ name });
      mirror({ name });
    },
    [queryClient, mirror],
  );

  const adopt = useCallback(
    (user: Pick<User, "theme" | "locale">) => {
      // While a save is on its way the session already shows the new choice,
      // and the note of it is settled when the answer arrives.
      const saving = sending.current > 0;
      const waiting = saving ? {} : readUnsaved(storage());
      const theme = waiting.theme ?? user.theme;
      const locale = waiting.locale ?? user.locale;
      setThemeState(theme);
      storeTheme(storage(), theme);
      setLocaleState(locale);
      storeLocale(storage(), locale);
      if (saving) return;

      const resend: UnsavedChoices = {};
      if (waiting.theme !== undefined && waiting.theme !== user.theme) resend.theme = waiting.theme;
      if (waiting.locale !== undefined && waiting.locale !== user.locale) resend.locale = waiting.locale;
      // Whatever the server already agrees with needs no note any more.
      forgetUnsaved(storage(), { theme: user.theme, locale: user.locale });
      if (Object.keys(resend).length > 0) sendQuietly(resend);
    },
    [sendQuietly],
  );

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
