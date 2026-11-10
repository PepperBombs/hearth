/**
 * Server settings. Read once at start-up from environment variables and,
 * optionally, a JSON file named by HEARTH_CONFIG. The environment wins.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const AUTH_MODES = ["cloudflare-access", "dev"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type AuthConfig =
  | { mode: "cloudflare-access"; teamDomain: string; audience: string }
  | { mode: "dev"; devUser: string };

export type Config = {
  host: string;
  port: number;
  /** Absolute path of the SQLite file, or ":memory:". */
  dbPath: string;
  /** Stored for later steps. */
  appsDir: string | null;
  /** Stored for later steps. */
  dataDir: string | null;
  /** Absolute path of the folder holding the built web app. */
  webDist: string;
  auth: AuthConfig;
  /** Lower-case. */
  ownerEmail: string;
  version: string;
};

/** Thrown when the settings are missing or wrong. The message is meant to be shown as is. */
export class ConfigError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      [
        "Hearth cannot start: the configuration is not valid.",
        ...problems.map((problem) => `  - ${problem}`),
        "Set these as environment variables or in the JSON file named by HEARTH_CONFIG.",
        "Every setting is described in packages/server/README.md.",
      ].join("\n"),
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

const SETTING_NAMES = [
  "HOST",
  "PORT",
  "HEARTH_DB",
  "HEARTH_APPS_DIR",
  "HEARTH_DATA_DIR",
  "HEARTH_WEB_DIST",
  "HEARTH_AUTH",
  "HEARTH_CF_TEAM_DOMAIN",
  "HEARTH_CF_AUDIENCE",
  "HEARTH_OWNER_EMAIL",
  "HEARTH_DEV_USER",
  "HEARTH_VERSION",
] as const;
type SettingName = (typeof SETTING_NAMES)[number];

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "must be an email address, for example you@example.com" }));

const settingsSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce
    .number({ error: "must be a port number between 1 and 65535" })
    .int({ error: "must be a port number between 1 and 65535" })
    .min(1, { error: "must be a port number between 1 and 65535" })
    .max(65535, { error: "must be a port number between 1 and 65535" })
    .default(4310),
  HEARTH_DB: z.string().default("./data/hearth.db"),
  HEARTH_APPS_DIR: z.string().optional(),
  HEARTH_DATA_DIR: z.string().optional(),
  HEARTH_WEB_DIST: z.string().optional(),
  HEARTH_AUTH: z
    .enum(AUTH_MODES, { error: 'must be "cloudflare-access" or "dev"' })
    .default("cloudflare-access"),
  HEARTH_CF_TEAM_DOMAIN: z.string().optional(),
  HEARTH_CF_AUDIENCE: z.string().optional(),
  HEARTH_OWNER_EMAIL: email.optional(),
  HEARTH_DEV_USER: email.optional(),
  HEARTH_VERSION: z
    .string()
    .max(64, { error: "must be at most 64 characters" })
    .default("dev"),
});

/** True for addresses that only this machine can reach. */
export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value === "::1") return true;
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Accepts "team.cloudflareaccess.com" with or without a scheme or trailing slash. */
function normaliseTeamDomain(value: string): string | null {
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const label = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
  return new RegExp(`^${label}(\\.${label})+$`).test(host) ? host : null;
}

/** The folder of the @hearth/server package, whether running from src or from dist. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

function readConfigFile(path: string, cwd: string): Record<string, string> {
  const absolute = resolve(cwd, path);
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch {
    throw new ConfigError([`HEARTH_CONFIG names a file that cannot be read: ${absolute}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError([`HEARTH_CONFIG names a file that is not valid JSON: ${absolute}`]);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError([
      `HEARTH_CONFIG must hold a JSON object of settings, for example {"PORT": 4310}: ${absolute}`,
    ]);
  }
  const known = new Set<string>(SETTING_NAMES);
  const values: Record<string, string> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!known.has(key)) {
      problems.push(`${key} in the config file is not a setting Hearth knows.`);
    } else if (typeof value === "string" || typeof value === "number") {
      values[key] = String(value);
    } else if (value !== null) {
      problems.push(`${key} in the config file must be a string or a number.`);
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return values;
}

export type LoadConfigOptions = {
  /** Folder that relative paths are resolved against. Defaults to the working directory. */
  cwd?: string;
};

/**
 * Reads and checks the settings. Throws ConfigError, whose message names
 * everything that is missing or wrong, so that start-up can stop with it.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: LoadConfigOptions = {},
): Config {
  const cwd = options.cwd ?? process.cwd();
  const configFile = env.HEARTH_CONFIG?.trim();
  const fromFile = configFile ? readConfigFile(configFile, cwd) : {};

  // An empty value counts as not set, so `HEARTH_APPS_DIR=` in a unit file is harmless.
  const raw: Partial<Record<SettingName, string>> = {};
  for (const name of SETTING_NAMES) {
    const value = (env[name] ?? "").trim() || (fromFile[name] ?? "").trim();
    if (value) raw[name] = value;
  }

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}.`),
    );
  }
  const settings = parsed.data;
  const problems: string[] = [];

  if (!settings.HEARTH_OWNER_EMAIL) {
    problems.push(
      "HEARTH_OWNER_EMAIL is required: the email address of the person who owns this server.",
    );
  }

  let auth: AuthConfig | null = null;
  if (settings.HEARTH_AUTH === "cloudflare-access") {
    const teamDomain = settings.HEARTH_CF_TEAM_DOMAIN
      ? normaliseTeamDomain(settings.HEARTH_CF_TEAM_DOMAIN)
      : null;
    if (!settings.HEARTH_CF_TEAM_DOMAIN) {
      problems.push(
        'HEARTH_CF_TEAM_DOMAIN is required when HEARTH_AUTH is "cloudflare-access", for example your-team.cloudflareaccess.com.',
      );
    } else if (!teamDomain) {
      problems.push(
        "HEARTH_CF_TEAM_DOMAIN must be a host name, for example your-team.cloudflareaccess.com.",
      );
    }
    if (!settings.HEARTH_CF_AUDIENCE) {
      problems.push(
        'HEARTH_CF_AUDIENCE is required when HEARTH_AUTH is "cloudflare-access": the Application Audience (AUD) tag of the Access application.',
      );
    }
    if (teamDomain && settings.HEARTH_CF_AUDIENCE) {
      auth = { mode: "cloudflare-access", teamDomain, audience: settings.HEARTH_CF_AUDIENCE };
    }
  } else {
    if (!isLoopbackHost(settings.HOST)) {
      problems.push(
        `HEARTH_AUTH is "dev", which signs everyone in without checking, so HOST must be a loopback address (127.0.0.1, ::1 or localhost), not ${settings.HOST}.`,
      );
    }
    const devUser = settings.HEARTH_DEV_USER ?? settings.HEARTH_OWNER_EMAIL;
    if (devUser) auth = { mode: "dev", devUser };
  }

  if (problems.length > 0 || !auth || !settings.HEARTH_OWNER_EMAIL) {
    throw new ConfigError(problems);
  }

  const optionalPath = (value: string | undefined) => (value ? resolve(cwd, value) : null);
  return {
    host: settings.HOST,
    port: settings.PORT,
    dbPath: settings.HEARTH_DB === ":memory:" ? ":memory:" : resolve(cwd, settings.HEARTH_DB),
    appsDir: optionalPath(settings.HEARTH_APPS_DIR),
    dataDir: optionalPath(settings.HEARTH_DATA_DIR),
    webDist: settings.HEARTH_WEB_DIST
      ? resolve(cwd, settings.HEARTH_WEB_DIST)
      : resolve(packageRoot(), "../web/dist"),
    auth,
    ownerEmail: settings.HEARTH_OWNER_EMAIL,
    version: settings.HEARTH_VERSION,
  };
}
