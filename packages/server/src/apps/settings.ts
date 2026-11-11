/**
 * An app's settings as its code reads them (`ctx.settings`).
 *
 * So far these are the defaults its manifest declares: nothing can be saved
 * yet. The settings routes and the stored values (the space's, then the
 * caller's own, then defaults) replace the body of `settingsFor`; whoever
 * calls it need not change.
 *
 * Design: docs/mini-app-contract.md, sections A2 and A8.
 */
import type { Manifest } from "@hearth/sdk";
import type { SettingValue } from "@hearth/shared";

/** The value of every setting the manifest declares, by name. */
export function settingsFor(manifest: Manifest): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const [name, setting] of Object.entries(manifest.settings ?? {})) {
    // A copy, so that a handler that changes a list does not change the manifest's default.
    values[name] = typeof setting.default === "object" ? [...setting.default] : setting.default;
  }
  return values;
}
