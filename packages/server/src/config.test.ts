import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, isLoopbackHost, loadConfig } from "./config";

const CWD = "/srv/hearth";
const load = (env: Record<string, string | undefined>) => loadConfig(env, { cwd: CWD });

const cloudflare = {
  HEARTH_OWNER_EMAIL: "owner@example.com",
  HEARTH_CF_TEAM_DOMAIN: "team.example.com",
  HEARTH_CF_AUDIENCE: "aud-tag",
};

function problemsOf(env: Record<string, string | undefined>): string {
  try {
    load(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("Expected the configuration to be refused.");
}

describe("loadConfig", () => {
  it("applies the defaults", () => {
    const config = load(cloudflare);
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 4310,
      dbPath: resolve(CWD, "data/hearth.db"),
      appsDir: null,
      dataDir: null,
      auth: { mode: "cloudflare-access", teamDomain: "team.example.com", audience: "aud-tag" },
      ownerEmail: "owner@example.com",
      version: "dev",
    });
    expect(config.webDist).toBe(resolve(import.meta.dirname, "../../web/dist"));
  });

  it("reads every setting", () => {
    const config = load({
      ...cloudflare,
      HOST: "::1",
      PORT: "8080",
      HEARTH_DB: "/var/lib/hearth/hearth.db",
      HEARTH_APPS_DIR: "../hearth-stones",
      HEARTH_DATA_DIR: "/srv/hearth-data",
      HEARTH_WEB_DIST: "web",
      HEARTH_VERSION: "abc1234",
    });
    expect(config).toMatchObject({
      host: "::1",
      port: 8080,
      dbPath: "/var/lib/hearth/hearth.db",
      appsDir: "/srv/hearth-stones",
      dataDir: "/srv/hearth-data",
      webDist: "/srv/hearth/web",
      version: "abc1234",
    });
  });

  it("lower-cases email addresses and tidies the team domain", () => {
    const config = load({
      ...cloudflare,
      HEARTH_OWNER_EMAIL: " Owner@Example.COM ",
      HEARTH_CF_TEAM_DOMAIN: "https://Team.Example.com/",
    });
    expect(config.ownerEmail).toBe("owner@example.com");
    expect(config.auth).toMatchObject({ teamDomain: "team.example.com" });
  });

  it("names everything that is missing", () => {
    const message = problemsOf({});
    expect(message).toContain("HEARTH_OWNER_EMAIL is required");
    expect(message).toContain("HEARTH_CF_TEAM_DOMAIN is required");
    expect(message).toContain("HEARTH_CF_AUDIENCE is required");
  });

  it("treats an empty value as not set", () => {
    expect(problemsOf({ ...cloudflare, HEARTH_CF_AUDIENCE: "  " })).toContain(
      "HEARTH_CF_AUDIENCE is required",
    );
    expect(load({ ...cloudflare, PORT: "" }).port).toBe(4310);
  });

  it("refuses values that make no sense", () => {
    expect(problemsOf({ ...cloudflare, PORT: "http" })).toContain("PORT must be a port number");
    expect(problemsOf({ ...cloudflare, PORT: "70000" })).toContain("PORT must be a port number");
    expect(problemsOf({ ...cloudflare, HEARTH_AUTH: "none" })).toContain(
      'HEARTH_AUTH must be "cloudflare-access" or "dev"',
    );
    expect(problemsOf({ ...cloudflare, HEARTH_OWNER_EMAIL: "owner" })).toContain(
      "HEARTH_OWNER_EMAIL must be an email address",
    );
    expect(problemsOf({ ...cloudflare, HEARTH_CF_TEAM_DOMAIN: "team/path" })).toContain(
      "HEARTH_CF_TEAM_DOMAIN must be a host name",
    );
  });

  describe("dev mode", () => {
    const dev = { HEARTH_AUTH: "dev", HEARTH_OWNER_EMAIL: "owner@example.com" };

    it("needs no Cloudflare settings and signs in as the owner", () => {
      expect(load(dev).auth).toEqual({ mode: "dev", devUser: "owner@example.com" });
    });

    it("can sign in as someone else", () => {
      expect(load({ ...dev, HEARTH_DEV_USER: "Guest@Example.com" }).auth).toEqual({
        mode: "dev",
        devUser: "guest@example.com",
      });
    });

    it("refuses to listen anywhere but on a loopback address", () => {
      expect(problemsOf({ ...dev, HOST: "0.0.0.0" })).toContain("HOST must be a loopback address");
      expect(problemsOf({ ...dev, HOST: "192.0.2.10" })).toContain(
        "HOST must be a loopback address",
      );
      expect(load({ ...dev, HOST: "localhost" }).host).toBe("localhost");
      expect(load({ ...dev, HOST: "::1" }).host).toBe("::1");
    });

    it("takes an IPv6 address written in brackets, and stores the form a socket can listen on", () => {
      expect(load({ ...dev, HOST: "[::1]" }).host).toBe("::1");
      expect(problemsOf({ ...dev, HOST: "[::]" })).toContain("HOST must be a loopback address");
    });

    it("still needs the owner", () => {
      expect(problemsOf({ HEARTH_AUTH: "dev" })).toContain("HEARTH_OWNER_EMAIL is required");
    });
  });

  it("allows a public address behind Cloudflare Access when asked for", () => {
    expect(load({ ...cloudflare, HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(load({ ...cloudflare, HOST: "[::]" }).host).toBe("::");
  });

  it("refuses an owner address with a character that only looks like a letter", () => {
    // U+212A, the Kelvin sign, lower-cases to "k".
    expect(problemsOf({ ...cloudflare, HEARTH_OWNER_EMAIL: "mi\u212ae@example.com" })).toContain(
      "HEARTH_OWNER_EMAIL must be an email address",
    );
  });

  describe("config file", () => {
    function fileWith(content: string): string {
      const path = join(mkdtempSync(join(tmpdir(), "hearth-config-")), "hearth.json");
      writeFileSync(path, content);
      return path;
    }

    it("supplies settings, and the environment wins", () => {
      const path = fileWith(
        JSON.stringify({ ...cloudflare, PORT: 5000, HEARTH_VERSION: "from-file" }),
      );
      const config = load({ HEARTH_CONFIG: path, HEARTH_VERSION: "from-env" });
      expect(config.port).toBe(5000);
      expect(config.version).toBe("from-env");
      expect(config.ownerEmail).toBe("owner@example.com");
    });

    it("is refused when it cannot be read, is not JSON, or holds unknown settings", () => {
      expect(problemsOf({ HEARTH_CONFIG: "/nonexistent/hearth.json" })).toContain(
        "cannot be read",
      );
      expect(problemsOf({ HEARTH_CONFIG: fileWith("{ nope") })).toContain("not valid JSON");
      expect(problemsOf({ HEARTH_CONFIG: fileWith("[]") })).toContain("JSON object");
      expect(problemsOf({ HEARTH_CONFIG: fileWith(JSON.stringify({ HEARTH_PORT: 1 })) })).toContain(
        "HEARTH_PORT in the config file is not a setting",
      );
    });
  });
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "accepts %s",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );
  it.each(["0.0.0.0", "::", "192.0.2.1", "127.0.0.1.example.com", "127.0.0", "example.com", ""])(
    "refuses %s",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );
});
