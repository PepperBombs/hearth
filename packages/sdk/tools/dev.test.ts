/**
 * `hearth-apps dev` up to the moment it starts the framework's dev servers,
 * which a test cannot hold (their ports are fixed): what it syncs, where it
 * starts them and with which environment. The refusals of the command as it
 * is run are in cli.test.ts.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_OWNER_EMAIL, dev, devEnvironment, startDevServers } from "./dev.mjs";
import { GENERATED } from "./sync.mjs";
import { ROOT, appFiles, makeRepo, removeTempDirs, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

type Start = typeof startDevServers;

/** Runs `dev` with the servers' start recorded instead of done, and the generated files sent to a temporary folder. */
async function devWith(appsDirs: string[], env: NodeJS.ProcessEnv) {
  const out = tempDir();
  const lines: string[] = [];
  const started: Parameters<Start>[0][] = [];
  const start: Start = async (options) => {
    started.push(options);
    return 0;
  };
  const status = await dev({ appsDirs, root: ROOT, out, env, start, log: (line) => lines.push(line) });
  return { status, started, output: lines.join("\n"), out };
}

describe("hearth-apps dev", () => {
  it("syncs the folder, then starts the framework's dev servers with it, sign-in switched off", async () => {
    const repo = makeRepo({ fixtures: ["checklist", "feed"] });
    const run = await devWith([repo], { PATH: "/usr/bin", HOME: "/home/sample" });

    expect(run.status).toBe(0);
    expect(run.started).toHaveLength(1);
    expect(run.started[0]?.root).toBe(ROOT);
    expect(run.started[0]?.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/sample",
      HEARTH_APPS_DIR: repo,
      HEARTH_AUTH: "dev",
      HEARTH_OWNER_EMAIL: DEV_OWNER_EMAIL,
    });
    expect(fs.readFileSync(path.join(run.out, GENERATED.web), "utf8")).toContain(`${path.basename(repo)}/checklist/widget.tsx`);
    expect(run.output).toContain("running Hearth with 2 mini-apps (checklist, feed)");
    expect(run.output).toContain(`Sign-in is off: everyone is ${DEV_OWNER_EMAIL}.`);
  });

  it("keeps the owner and the person signed in that the environment names, and passes several folders like PATH", async () => {
    const notes = makeRepo({ files: appFiles("notes") });
    const diary = makeRepo({ files: appFiles("diary") });
    const run = await devWith([notes, diary], {
      HEARTH_OWNER_EMAIL: "owner@example.com",
      HEARTH_DEV_USER: "lin@example.com",
      HEARTH_AUTH: "cloudflare-access",
    });

    expect(run.started[0]?.env).toMatchObject({
      HEARTH_APPS_DIR: `${notes}${path.delimiter}${diary}`,
      HEARTH_AUTH: "dev",
      HEARTH_OWNER_EMAIL: "owner@example.com",
      HEARTH_DEV_USER: "lin@example.com",
    });
    expect(run.output).toContain("everyone is lin@example.com.");
  });

  it("starts Hearth without apps for a folder that holds none", async () => {
    const run = await devWith([tempDir()], {});
    expect(run.status).toBe(0);
    expect(run.output).toContain("no mini-apps to run; starting Hearth without any.");
    expect(run.started).toHaveLength(1);
  });

  it("starts nothing when sync refuses the apps, and ends with sync's status", async () => {
    const run = await devWith([makeRepo({ sdk: "^0.9.0", fixtures: ["feed"] })], {});
    expect(run.status).toBe(3);
    expect(run.started).toEqual([]);
    expect(fs.readdirSync(run.out)).toEqual([]);
  });

  it("ends with the dev servers' own status", async () => {
    const lines: string[] = [];
    const status = await dev({
      appsDirs: [tempDir()],
      root: ROOT,
      out: tempDir(),
      env: {},
      start: async () => 130,
      log: (line) => lines.push(line),
    });
    expect(status).toBe(130);
  });
});

describe("startDevServers", () => {
  /** Whether something listens on this port of this machine. */
  const listening = (port: number) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });

  it("stops every process below it when it is told to stop, not pnpm alone", { timeout: 60_000 }, async () => {
    // A stand-in for the framework's `pnpm dev`: a script whose child holds
    // a port, as the dev servers do below pnpm, a shell and concurrently.
    const root = tempDir();
    write(root, {
      "package.json": `${JSON.stringify({ name: "stand-in", private: true, scripts: { dev: "node servers.mjs" } })}\n`,
      "servers.mjs": [
        'import { spawn } from "node:child_process";',
        'import fs from "node:fs";',
        "const server = 'require(\"node:net\").createServer().listen(0, \"127.0.0.1\", function () { require(\"node:fs\").writeFileSync(\"port\", String(this.address().port)); });';",
        'const child = spawn(process.execPath, ["-e", server], { stdio: "ignore" });',
        'fs.writeFileSync("pids", JSON.stringify([process.pid, child.pid]));',
        "setInterval(() => {}, 1000);",
        "",
      ].join("\n"),
    });
    const signals = new EventEmitter();
    // Silent, so that pnpm's report of the stop it was given does not read like a failure in the log.
    const env = { ...process.env, npm_config_loglevel: "silent" };
    const running = startDevServers({ root, env, log: () => {}, signals });

    const portFile = path.join(root, "port");
    try {
      await vi.waitFor(() => expect(fs.existsSync(portFile)).toBe(true), { timeout: 30_000, interval: 100 });
      const port = Number(fs.readFileSync(portFile, "utf8"));
      expect(await listening(port)).toBe(true);

      signals.emit("SIGTERM", "SIGTERM");
      expect(await running).toBe(0);
      await vi.waitFor(async () => expect(await listening(port)).toBe(false), { timeout: 10_000, interval: 100 });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      // Whatever happened, nothing of the stand-in outlives the test.
      const pids: number[] = fs.existsSync(path.join(root, "pids")) ? JSON.parse(fs.readFileSync(path.join(root, "pids"), "utf8")) : [];
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Stopped already, as it should be.
        }
      }
    }
  });
});

describe("devEnvironment", () => {
  it("treats an empty owner as none", () => {
    expect(devEnvironment({ HEARTH_OWNER_EMAIL: "  " }, ["/apps"])).toMatchObject({ HEARTH_OWNER_EMAIL: DEV_OWNER_EMAIL });
  });
});
