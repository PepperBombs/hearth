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
      dataDir: null,
      auth: { mode: "cloudflare-access", teamDomain: "team.example.com", audience: "aud-tag" },
      ownerEmail: "owner@example.com",
      // Owner's decision 4: groups and new people are the server's owner's alone until opened up.
      groupPolicy: "owner",
      version: "dev",
      // The mini-apps' jobs run, and fetch from the hosts themselves.
      jobs: "on",
      fetchStandIns: null,
    });
    expect(config.webDist).toBe(resolve(import.meta.dirname, "../../web/dist"));
  });

  it("reads every setting", () => {
    const config = load({
      ...cloudflare,
      HOST: "::1",
      PORT: "8080",
      HEARTH_DB: "/var/lib/hearth/hearth.db",
      HEARTH_DATA_DIR: "/srv/hearth-data",
      HEARTH_WEB_DIST: "web",
      HEARTH_GROUP_POLICY: "everyone",
      HEARTH_VERSION: "abc1234",
      HEARTH_JOBS: "off",
    });
    expect(config).toMatchObject({
      host: "::1",
      port: 8080,
      dbPath: "/var/lib/hearth/hearth.db",
      dataDir: "/srv/hearth-data",
      webDist: "/srv/hearth/web",
      groupPolicy: "everyone",
      version: "abc1234",
      jobs: "off",
    });
  });

  it("switches the mini-apps' jobs on or off, and nothing else", () => {
    expect(load({ ...cloudflare, HEARTH_JOBS: "on" }).jobs).toBe("on");
    expect(load({ ...cloudflare, HEARTH_JOBS: "off" }).jobs).toBe("off");
    // Empty counts as not set: on.
    expect(load({ ...cloudflare, HEARTH_JOBS: " " }).jobs).toBe("on");
    for (const value of ["no", "false", "0", "OFF", "disabled"]) {
      expect(problemsOf({ ...cloudflare, HEARTH_JOBS: value })).toContain('HEARTH_JOBS must be "on" or "off"');
    }
    // In dev mode, with or without stand-ins, as the end-to-end tests start the server.
    const dev = { HEARTH_AUTH: "dev", HEARTH_OWNER_EMAIL: "owner@example.com" };
    expect(load({ ...dev, HEARTH_JOBS: "off" }).jobs).toBe("off");
    expect(load({ ...dev, HEARTH_FETCH_STANDINS: "/tmp/standins.json" })).toMatchObject({
      jobs: "on",
      fetchStandIns: "/tmp/standins.json",
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
    expect(problemsOf({ ...cloudflare, HEARTH_GROUP_POLICY: "members" })).toContain(
      'HEARTH_GROUP_POLICY must be "owner" or "everyone"',
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

    it("may answer every fetch of a job from a file of stand-ins, for end-to-end tests", () => {
      expect(load(dev).fetchStandIns).toBeNull();
      expect(load({ ...dev, HEARTH_FETCH_STANDINS: "e2e/standins.json" }).fetchStandIns).toBe(
        "/srv/hearth/e2e/standins.json",
      );
      expect(load({ ...dev, HEARTH_FETCH_STANDINS: "/tmp/standins.json" }).fetchStandIns).toBe("/tmp/standins.json");
    });
  });

  it("refuses stand-in answers for jobs on a server that checks who signs in", () => {
    const message = problemsOf({ ...cloudflare, HEARTH_FETCH_STANDINS: "/tmp/standins.json" });
    expect(message).toContain("HEARTH_FETCH_STANDINS answers every fetch of a job from a file");
    expect(message).toContain("so it needs HEARTH_AUTH=dev");
    // Unset, or empty, is what a real server has.
    expect(load({ ...cloudflare, HEARTH_FETCH_STANDINS: " " }).fetchStandIns).toBeNull();
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

  it("does not read the mini-apps' folder: the build decided which apps this server holds", () => {
    const config = load({ ...cloudflare, HEARTH_APPS_DIR: "../hearth-stones" });
    expect(config).not.toHaveProperty("appsDir");
    expect(JSON.stringify(config)).not.toContain("hearth-stones");
  });

  describe("config file", () => {
    function fileWith(content: string): string {
      const path = join(mkdtempSync(join(tmpdir(), "hearth-config-")), "hearth.json");
      writeFileSync(path, content);
      return path;
    }

    it("supplies settings, and the environment wins", () => {
      const path = fileWith(
        JSON.stringify({ ...cloudflare, PORT: 5000, HEARTH_VERSION: "from-file", HEARTH_JOBS: "off" }),
      );
      const config = load({ HEARTH_CONFIG: path, HEARTH_VERSION: "from-env" });
      expect(config.port).toBe(5000);
      expect(config.version).toBe("from-env");
      expect(config.ownerEmail).toBe("owner@example.com");
      expect(config.jobs).toBe("off");
      expect(load({ HEARTH_CONFIG: path, HEARTH_JOBS: "on" }).jobs).toBe("on");
    });

    it("may name stand-ins for jobs only as dev mode may", () => {
      const standIns = { HEARTH_FETCH_STANDINS: "/tmp/standins.json" };
      expect(problemsOf({ HEARTH_CONFIG: fileWith(JSON.stringify({ ...cloudflare, ...standIns })) })).toContain(
        "so it needs HEARTH_AUTH=dev",
      );
      const dev = { HEARTH_AUTH: "dev", HEARTH_OWNER_EMAIL: "owner@example.com", ...standIns };
      expect(load({ HEARTH_CONFIG: fileWith(JSON.stringify(dev)) }).fetchStandIns).toBe("/tmp/standins.json");
    });

    it("may still name the mini-apps' folder, as a file written for an earlier release does", () => {
      const path = fileWith(JSON.stringify({ ...cloudflare, HEARTH_APPS_DIR: "/srv/hearth-stones", PORT: 5000 }));
      const config = load({ HEARTH_CONFIG: path });
      expect(config.port).toBe(5000);
      expect(config).not.toHaveProperty("appsDir");
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
