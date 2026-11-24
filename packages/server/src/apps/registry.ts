/**
 * The apps this server holds, as every part of it asks after one: whether
 * an app of this ID exists, and what its manifest says.
 *
 * Every app is made in Hearth (docs/platform.md): its manifest and its page
 * live in the database (src/made/apps.ts), and `madeAppsRegistry` there is
 * the registry the server uses. Whether a space *has* an app is a row in
 * `space_apps` (see installs.ts); an entry whose app the server holds no
 * longer, such as an install of one of the apps of releases before the
 * built-in apps that could not move to its built-in app, is hidden and its
 * data left alone.
 */
import type { Manifest } from "@hearth/sdk";

/** An app the server holds. */
export type RegisteredApp = {
  id: string;
  /** The app as every app's manifest says it: its name and look in both languages, its hosts and its settings. */
  manifest: Manifest;
  /** Whether the app has a page of its own besides its dashboard card: every made app has. */
  hasPage: boolean;
  /** An app made in Hearth (src/made/apps.ts): a page run in the sandbox. */
  made: true;
  /** The version in use, which changes with every change to the app. */
  version: number;
  /** The built-in app it was added from, when it was. */
  template?: string;
  /** The one space it lives in: it cannot be added to another. */
  madeIn: string;
  /**
   * For a copy of a published app (docs/center.md): the listing it came
   * from, missing once that is unpublished, and whether it is still as it
   * was shared.
   */
  copy?: { listingId?: string; untouched: boolean };
};

export type Registry = {
  /** The app with this ID, or undefined when the server holds no app of it. */
  get(appId: string): RegisteredApp | undefined;
  has(appId: string): boolean;
};
