/**
 * An app's settings in one space: what its manifest declares, filled with
 * what people saved.
 *
 * A setting belongs to the space (one value, shared by everyone in it) or
 * to the user (one value for each person in that space). Only values are
 * stored, as one JSON object for the space and one per person, and they are
 * read against the manifest as it is today:
 *
 * - a setting nobody saved has the manifest's default, so a default can
 *   change without touching the database;
 * - a value saved under a name the manifest no longer declares, or under
 *   the other scope, is not read at all;
 * - a saved value that no longer fits its setting (an option that is gone,
 *   a shorter `maxLength`) reads as the default. A multi-select first loses
 *   the keys that are no longer options.
 *
 * Nothing that is not read is deleted: saving a setting replaces that one
 * value and leaves the rest of the stored object alone. A release that is
 * rolled back, or a setting that returns, finds its values again.
 *
 * Three callers: a handler's `ctx.settings` (`settingsFor`, called from
 * calls.ts inside the call's transaction) and the two settings routes
 * (`readAppSettings`, `changeAppSettings`). The SQL is in store.ts.
 *
 * Design: docs/mini-app-contract.md, sections A2, A6 and A8, and the
 * owner's decision 5.
 */
import type { Manifest, Setting } from "@hearth/sdk";
import { settingValueProblems } from "@hearth/sdk/manifest-schema";
import type { AppSettings, AppSettingsPatch, SettingValue } from "@hearth/shared";
import type { Db } from "../db/database";
import { notFound, Refusal } from "../http/errors";
import { resolveInstall, type AppRequest } from "./installs";
import type { Registry } from "./registry";
import {
  readSettingsData,
  writeSettingsData,
  type SettingsData,
  type SettingsOwner,
  type SettingsScope,
} from "./store";

const SCOPES = ["space", "user"] as const satisfies readonly SettingsScope[];

/** A copy, so that whoever changes a list they were given changes neither the manifest's default nor anyone else's. */
const copy = (value: SettingValue | readonly string[]): SettingValue =>
  typeof value === "object" ? [...value] : value;

/** The value of one setting: what was saved under its name if that still fits, else its default. */
function valueOf(name: string, setting: Setting, saved: SettingsData): SettingValue {
  if (Object.hasOwn(saved, name)) {
    let value = saved[name];
    if (setting.type === "multi-select" && Array.isArray(value)) {
      // Options come and go with releases; what is left of the person's choice is still theirs.
      const keys: unknown[] = value;
      value = keys.filter(
        (key, index) => typeof key === "string" && Object.hasOwn(setting.options, key) && keys.indexOf(key) === index,
      );
    }
    if (settingValueProblems(setting, value).length === 0) return copy(value as SettingValue);
  }
  return copy(setting.default);
}

/** Every setting the manifest declares, under its scope, with its value. */
function fill(manifest: Manifest, saved: Record<SettingsScope, SettingsData>): AppSettings {
  const settings: AppSettings = { space: {}, user: {} };
  for (const [name, setting] of Object.entries(manifest.settings ?? {})) {
    settings[setting.scope][name] = valueOf(name, setting, saved[setting.scope]);
  }
  return settings;
}

/**
 * An app's settings as its code reads them (`ctx.settings`): every setting
 * the manifest declares, by name, with the space's value or this person's
 * own, whichever the setting's scope says.
 *
 * The caller has checked that the person may use the app in this space, and
 * holds the transaction that check was made in.
 */
export function settingsFor(db: Db, owner: SettingsOwner, manifest: Manifest): Record<string, SettingValue> {
  const { space, user } = fill(manifest, readSettingsData(db, owner));
  // A name is declared once, so it is in one of the two.
  return { ...space, ...user };
}

/**
 * An app's settings as the settings form shows them: the values shared by
 * the space and the caller's own, defaults filled in. Anyone who can see
 * the app may read both.
 *
 * Throws a Refusal: 404 when the app is not there for this person.
 */
export function readAppSettings(db: Db, registry: Registry, request: AppRequest): AppSettings {
  const { userId, spaceId, appId } = request;
  return db
    .transaction(() => {
      const app = registry.get(appId);
      if (!app || resolveInstall(db, registry, userId, spaceId, appId) === null) throw notFound();
      return fill(app.manifest, readSettingsData(db, { spaceId, appId, userId }));
    })
    .deferred();
}

/**
 * Saves settings: only the ones the patch names, and all of them or none.
 * Answers with every setting as it is afterwards.
 *
 * A setting shared by the space needs edit access to the app. A person's
 * own settings are theirs to change with view access too, and are saved for
 * them alone.
 *
 * Throws a Refusal:
 * - 404 when the app is not there for this person;
 * - 403 when the patch names a setting of the space and the person may only view;
 * - 400 when a name is not a setting of that scope in the app's manifest,
 *   or a value does not fit its setting.
 */
export function changeAppSettings(
  db: Db,
  registry: Registry,
  request: AppRequest & { patch: AppSettingsPatch },
): AppSettings {
  const { userId, spaceId, appId, patch } = request;
  return db
    .transaction(() => {
      const access = resolveInstall(db, registry, userId, spaceId, appId);
      const app = registry.get(appId);
      if (!app || access === null) throw notFound();
      if (access !== "edit" && Object.keys(patch.space ?? {}).length > 0) {
        throw new Refusal(403, "forbidden", "Changing the settings an app shares with the whole space needs edit access to it.");
      }

      // After the access checks, and before anything is written.
      const declared = app.manifest.settings ?? {};
      for (const scope of SCOPES) {
        for (const [name, value] of Object.entries(patch[scope] ?? {})) {
          const setting = Object.hasOwn(declared, name) ? declared[name] : undefined;
          if (!setting || setting.scope !== scope) {
            const kind = scope === "space" ? "shared by the space" : "of each person's own";
            throw new Refusal(400, "invalid_request", `${scope}.${name}: This app has no setting ${kind} with this name.`);
          }
          const [problem] = settingValueProblems(setting, value);
          if (problem) {
            const [path, message] = problem;
            throw new Refusal(400, "invalid_request", `${[scope, name, ...path].join(".")}: ${message}`);
          }
        }
      }

      const owner = { spaceId, appId, userId };
      const saved = readSettingsData(db, owner);
      const now = new Date();
      for (const scope of SCOPES) {
        const changes = patch[scope];
        if (!changes || Object.keys(changes).length === 0) continue;
        // Only the named values are replaced; whatever else is stored stays.
        writeSettingsData(db, { ...owner, now }, scope, { ...saved[scope], ...changes });
      }
      return fill(app.manifest, readSettingsData(db, owner));
    })
    .immediate();
}
