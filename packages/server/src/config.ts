/**
 * Server settings. Read once at start-up from environment variables and,
 * optionally, a JSON file named by HEARTH_CONFIG. The environment wins.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normaliseEmail } from "./email";

export const AUTH_MODES = ["cloudflare-access", "dev"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/**
 * Who may create groups and invite people who are not on this server yet
 * (owner's decision 4): the server's owner alone, or everyone on the server.
 * `groupRights` in src/groups/policy.ts is the one place that reads it.
 */
export const GROUP_POLICIES = ["owner", "everyone"] as const;
export type GroupPolicy = (typeof GROUP_POLICIES)[number];

/**
 * Whether this server runs its mini-apps' jobs (docs/mini-app-contract.md,
 * section C, "Switches"): "on", the default, or "off". Off, no job runs and
 * none fetches anything. The deploy's trial start and the end-to-end tests
 * switch them off.
 */
export const JOBS_SWITCH = ["on", "off"] as const;
export type JobsSwitch = (typeof JOBS_SWITCH)[number];

export type AuthConfig =
  | { mode: "cloudflare-access"; teamDomain: string; audience: string }
  | { mode: "dev"; devUser: string };

export type Config = {
  /** The address to listen on. An IPv6 address has no brackets. */
  host: string;
  port: number;
  /** Absolute path of the SQLite file, or ":memory:". */
  dbPath: string;
  /** Stored for later steps. */
  dataDir: string | null;
  /** Absolute path of the folder holding the built web app. */
  webDist: string;
  auth: AuthConfig;
  /** As normaliseEmail leaves it. */
  ownerEmail: string;
  groupPolicy: GroupPolicy;
  version: string;
  /**
   * Whether main.ts starts the scheduler (src/apps/scheduler.ts). Off, no
   * job runs; a job's status still answers, and a run asked for waits until
   * jobs run again.
   */
  jobs: JobsSwitch;
  /**
   * Absolute path of a JSON file of stand-in answers for every `ctx.fetch`
   * of a job, so that nothing reaches the network, or null. For end-to-end
   * tests, and only with HEARTH_AUTH=dev (src/apps/fetch.ts).
   */
  fetchStandIns: string | null;
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
  "HEARTH_DATA_DIR",
  "HEARTH_WEB_DIST",
  "HEARTH_AUTH",
  "HEARTH_CF_TEAM_DOMAIN",
  "HEARTH_CF_AUDIENCE",
  "HEARTH_OWNER_EMAIL",
  "HEARTH_DEV_USER",
  "HEARTH_GROUP_POLICY",
  "HEARTH_VERSION",
  "HEARTH_JOBS",
  "HEARTH_FETCH_STANDINS",
] as const;
type SettingName = (typeof SETTING_NAMES)[number];

/**
 * Names a config file may still hold although the server no longer reads
 * them, so that a file written for an earlier release does not stop this
 * one. HEARTH_APPS_DIR is read by the build (`hearth-apps sync`), which
 * decides which mini-apps a release holds; the running server has no use
 * for it.
 */
const IGNORED_NAMES: readonly string[] = ["HEARTH_APPS_DIR"];

// The same spelling the sign-in check produces, so the owner is recognised.
// Text normaliseEmail refuses goes on unchanged and fails the check after it.
const email = z
  .string()
  .transform((value) => normaliseEmail(value) ?? value.trim())
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
  HEARTH_DATA_DIR: z.string().optional(),
  HEARTH_WEB_DIST: z.string().optional(),
  HEARTH_AUTH: z
    .enum(AUTH_MODES, { error: 'must be "cloudflare-access" or "dev"' })
    .default("cloudflare-access"),
  HEARTH_CF_TEAM_DOMAIN: z.string().optional(),
  HEARTH_CF_AUDIENCE: z.string().optional(),
  HEARTH_OWNER_EMAIL: email.optional(),
  HEARTH_DEV_USER: email.optional(),
  HEARTH_GROUP_POLICY: z
    .enum(GROUP_POLICIES, { error: 'must be "owner" or "everyone"' })
    .default("owner"),
  HEARTH_VERSION: z
    .string()
    .max(64, { error: "must be at most 64 characters" })
    .default("dev"),
  HEARTH_JOBS: z.enum(JOBS_SWITCH, { error: 'must be "on" or "off"' }).default("on"),
  HEARTH_FETCH_STANDINS: z.string().optional(),
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
    if (IGNORED_NAMES.includes(key)) continue;
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

  // An empty value counts as not set, so `HEARTH_DATA_DIR=` in a unit file is harmless.
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
  // An IPv6 address is written in brackets in a URL, and the start-up line
  // prints it that way, but the address to listen on is the bare form.
  const host = settings.HOST.replace(/^\[(.*)\]$/, "$1");

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
    if (!isLoopbackHost(host)) {
      problems.push(
        `HEARTH_AUTH is "dev", which signs everyone in without checking, so HOST must be a loopback address (127.0.0.1, ::1 or localhost), not ${host}.`,
      );
    }
    const devUser = settings.HEARTH_DEV_USER ?? settings.HEARTH_OWNER_EMAIL;
    if (devUser) auth = { mode: "dev", devUser };
  }

  // Stand-ins answer for every host a job may reach. Only a server that
  // signs everyone in without checking, and so listens on loopback alone,
  // may have them: a real server can never be given made-up answers.
  if (settings.HEARTH_FETCH_STANDINS && settings.HEARTH_AUTH !== "dev") {
    problems.push(
      "HEARTH_FETCH_STANDINS answers every fetch of a job from a file, which is for end-to-end tests, so it needs HEARTH_AUTH=dev. A real server fetches from the hosts themselves: leave it unset.",
    );
  }

  if (problems.length > 0 || !auth || !settings.HEARTH_OWNER_EMAIL) {
    throw new ConfigError(problems);
  }

  const optionalPath = (value: string | undefined) => (value ? resolve(cwd, value) : null);
  return {
    host,
    port: settings.PORT,
    dbPath: settings.HEARTH_DB === ":memory:" ? ":memory:" : resolve(cwd, settings.HEARTH_DB),
    dataDir: optionalPath(settings.HEARTH_DATA_DIR),
    webDist: settings.HEARTH_WEB_DIST
      ? resolve(cwd, settings.HEARTH_WEB_DIST)
      : resolve(packageRoot(), "../web/dist"),
    auth,
    ownerEmail: settings.HEARTH_OWNER_EMAIL,
    groupPolicy: settings.HEARTH_GROUP_POLICY,
    version: settings.HEARTH_VERSION,
    jobs: settings.HEARTH_JOBS,
    fetchStandIns: optionalPath(settings.HEARTH_FETCH_STANDINS),
  };
}
