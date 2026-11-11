/**
 * Theme and language choices that have not reached the server yet, kept in
 * the browser so they survive a reload.
 *
 * A choice is noted here before it is sent and removed once the server has
 * it. What is left is a choice the server never got: the save failed, the
 * sign-in had expired, or there was no session to save it to. When a session
 * loads, these win over the server's stored values and are sent again.
 */
import type { PreferencesPatch } from "@hearth/shared";
import { isLocale } from "../i18n/locale";
import { isTheme } from "../theme/theme";

export type UnsavedChoices = Pick<PreferencesPatch, "theme" | "locale">;

export const UNSAVED_STORAGE_KEY = "hearth.unsaved";

export function readUnsaved(storage: Pick<Storage, "getItem"> | undefined): UnsavedChoices {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(UNSAVED_STORAGE_KEY) ?? "null");
    if (parsed === null || typeof parsed !== "object") return {};
    const { theme, locale } = parsed as Record<string, unknown>;
    return { ...(isTheme(theme) ? { theme } : {}), ...(isLocale(locale) ? { locale } : {}) };
  } catch {
    return {};
  }
}

function writeUnsaved(storage: Pick<Storage, "setItem" | "removeItem"> | undefined, choices: UnsavedChoices): void {
  try {
    if (Object.keys(choices).length === 0) storage?.removeItem(UNSAVED_STORAGE_KEY);
    else storage?.setItem(UNSAVED_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    /* Storage can be blocked; the choice then lasts for this visit only. */
  }
}

/** Notes choices that are about to be sent, replacing earlier ones for the same settings. */
export function noteUnsaved(storage: Storage | undefined, choices: UnsavedChoices): void {
  writeUnsaved(storage, { ...readUnsaved(storage), ...choices });
}

/**
 * Forgets choices the server now has. A setting changed again in the
 * meantime stays noted: its newer value is still on its way.
 */
export function forgetUnsaved(storage: Storage | undefined, saved: UnsavedChoices): void {
  const rest: Record<string, unknown> = { ...readUnsaved(storage) };
  for (const [key, value] of Object.entries(saved)) {
    if (rest[key] === value) delete rest[key];
  }
  writeUnsaved(storage, rest as UnsavedChoices);
}
