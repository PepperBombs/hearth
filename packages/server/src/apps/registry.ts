/**
 * The mini-apps whose code this server holds.
 *
 * The list is fixed when the server is built: an app's code arrives with a
 * deploy, never at run time. Whether a space *has* an app is a row in
 * `space_apps` (see installs.ts); whether the server can *run* it is whether
 * it is in this registry. An app that is in a space but not here is hidden
 * and its data left alone, so a mistaken deploy or a rollback loses nothing.
 *
 * Design: docs/mini-app-contract.md, sections A6 and A7.
 */
import type { Manifest } from "@hearth/sdk";
import { manifestSchema } from "@hearth/sdk/manifest-schema";
import { checkServer, type ServerDefinition } from "./definition";

/** One app as the build hands it to the server. */
export type BundledApp = {
  /** The name of the app's folder. Must equal `manifest.id`. */
  id: string;
  /** The default export of the app's `manifest.ts`. */
  manifest: Manifest;
  /** Whether the app has a `page.tsx`, and so a page of its own besides its dashboard card. */
  hasPage: boolean;
  /**
   * The default export of the app's `server.ts`. Present exactly when the
   * app has that file, so `undefined` here means a server file without a
   * default export, which createRegistry refuses. Untyped, because it comes
   * from code outside the framework: createRegistry checks it.
   */
  server?: unknown;
};

/** An app the registry accepted: its manifest and its server file have been checked. */
export type RegisteredApp = {
  id: string;
  manifest: Manifest;
  hasPage: boolean;
  /** The app's collections, queries and mutations. Absent for an app that keeps no data. */
  server?: ServerDefinition;
};

export type Registry = {
  /** The app with this ID, or undefined when the server holds no code for it. */
  get(appId: string): RegisteredApp | undefined;
  has(appId: string): boolean;
  /** Every app, in the order given. */
  list(): readonly RegisteredApp[];
};

/** Thrown when a bundled app cannot be used. The message is meant to be shown as is. */
export class AppRegistryError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      [
        "Hearth cannot start: a mini-app in this build is not valid.",
        ...problems.map((problem) => `  - ${problem}`),
        "Fix the app's manifest.ts or server.ts, or take its folder out, and build again.",
      ].join("\n"),
    );
    this.name = "AppRegistryError";
    this.problems = problems;
  }
}

/**
 * Checks every bundled app, its manifest and what its server file exports,
 * and returns the registry. Throws AppRegistryError naming everything that
 * is wrong, so that a server with a bad app never starts: the deploy tries a
 * new release before switching to it, and keeps the old one when the trial
 * fails.
 */
export function createRegistry(apps: readonly BundledApp[]): Registry {
  const problems: string[] = [];
  const byId = new Map<string, RegisteredApp>();

  apps.forEach((app, index) => {
    const label = typeof app.id === "string" && app.id !== "" ? `"${app.id}"` : `at position ${index}`;
    const parsed = manifestSchema.safeParse(app.manifest);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        problems.push(`App ${label}: manifest ${where}${issue.message}`);
      }
      return;
    }
    const manifest = parsed.data;
    if (app.id !== manifest.id) {
      problems.push(
        `App ${label}: the manifest's id is "${manifest.id}". An app's folder name and its manifest's id must be equal.`,
      );
      return;
    }
    if (byId.has(manifest.id)) {
      problems.push(`App ${label} is in this build twice. App IDs must be unique across all apps folders.`);
      return;
    }
    const registered: RegisteredApp = { id: app.id, manifest, hasPage: app.hasPage };
    if ("server" in app) {
      const faults =
        app.server === undefined
          ? ["server.ts has no default export. It must export what defineServer(manifest, collections).routes({ ... }) returns: export default app.routes({ ... })."]
          : checkServer(app.server, manifest);
      if (faults.length > 0) {
        problems.push(...faults.map((fault) => `App ${label}: ${fault}`));
        return;
      }
      registered.server = app.server as ServerDefinition;
    }
    byId.set(manifest.id, registered);
  });

  if (problems.length > 0) throw new AppRegistryError(problems);

  const list = [...byId.values()];
  return {
    get: (appId) => byId.get(appId),
    has: (appId) => byId.has(appId),
    list: () => list,
  };
}
