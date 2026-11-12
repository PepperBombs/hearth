/** Helpers for tests. Not part of the running server. */
import checklist from "../../fixture-apps/checklist/manifest";
import checklistServer from "../../fixture-apps/checklist/server";
import feed from "../../fixture-apps/feed/manifest";
import { createApp, type AppOptions } from "./app";
import type { BundledApp } from "./apps/registry";
import type { Identify } from "./auth";
import type { Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";

export const OWNER_EMAIL = "owner@example.com";

/**
 * The framework's own sample apps (packages/fixture-apps), as a build hands
 * them over: what `hearth-apps sync` writes for that folder. `checklist`
 * keeps rows and has a page of its own; `feed` has no server file and no
 * page.
 */
export const FIXTURE_APPS: readonly BundledApp[] = [
  { id: "checklist", manifest: checklist, hasPage: true, server: checklistServer },
  { id: "feed", manifest: feed, hasPage: false },
];

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 4310,
    dbPath: ":memory:",
    dataDir: null,
    webDist: "/nonexistent/hearth-web-dist",
    auth: {
      mode: "cloudflare-access",
      teamDomain: "team.example.com",
      audience: "test-audience",
    },
    ownerEmail: OWNER_EMAIL,
    groupPolicy: "owner",
    version: "test",
    fetchStandIns: null,
    ...overrides,
  };
}

export function testDatabase(): Db {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

/** Stands in for a login method: the request says who it is from in a test-only header. */
export const identifyFromTestHeader: Identify = async (request) => {
  const email = request.headers.get("x-test-identity");
  return email ? { email } : null;
};

export type TestAppOptions = {
  config?: Config;
  db?: Db;
  /** The mini-apps the server holds. Defaults to none; FIXTURE_APPS are the sample ones. */
  apps?: readonly BundledApp[];
  /** "from-config" uses the real login method the configuration names. */
  identify?: Identify | "from-config";
  logError?: AppOptions["logError"];
};

export function testApp(options: TestAppOptions = {}) {
  const db = options.db ?? testDatabase();
  const errors: unknown[] = [];
  const app = createApp({
    config: options.config ?? testConfig(),
    db,
    apps: options.apps ?? [],
    identify:
      options.identify === "from-config" ? undefined : (options.identify ?? identifyFromTestHeader),
    logError: options.logError ?? ((error) => errors.push(error)),
  });
  return { app, db, errors };
}

/** Headers for a request from the given person. */
export function as(email: string, headers: Record<string, string> = {}): Record<string, string> {
  return { "x-test-identity": email, ...headers };
}
