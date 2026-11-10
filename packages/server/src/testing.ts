/** Helpers for tests. Not part of the running server. */
import { createApp, type AppOptions } from "./app";
import type { Identify } from "./auth";
import type { Config } from "./config";
import { migrate, openDatabase, type Db } from "./db/database";

export const OWNER_EMAIL = "owner@example.com";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    host: "127.0.0.1",
    port: 4310,
    dbPath: ":memory:",
    appsDir: null,
    dataDir: null,
    webDist: "/nonexistent/hearth-web-dist",
    auth: {
      mode: "cloudflare-access",
      teamDomain: "team.example.com",
      audience: "test-audience",
    },
    ownerEmail: OWNER_EMAIL,
    version: "test",
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
