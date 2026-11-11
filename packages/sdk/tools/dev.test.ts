/**
 * `hearth-apps dev` up to the moment it starts the framework's dev servers,
 * which a test cannot hold (their ports are fixed): what it syncs, where it
 * starts them and with which environment. How they are stopped, against a
 * stand-in for them, also through a mini-apps repository's `pnpm dev`. The
 * refusals of the command as it is run are in cli.test.ts.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEV_OWNER_EMAIL, dev, devEnvironment, startDevServers } from "./dev.mjs";
import { GENERATED } from "./sync.mjs";
import { BIN, ROOT, SDK_DIR, appFiles, makeRepo, removeTempDirs, setUpStones, tempDir, write } from "./test-repos";

afterEach(removeTempDirs);

type Start = typeof startDevServers;

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

/**
 * A stand-in for the framework's `pnpm dev`, written into `root`: a script
 * whose child holds a port, as the dev servers do below pnpm, a shell and
 * concurrently. The script itself notes each stop signal it gets and ends
 * a moment later, as a server that closes what it holds; its child ends at
 * once. `port` waits until it listens; `stops` is what the script got;
 * `kill` makes sure that nothing of it outlives the test, whatever happened.
 */
function standInServers(root: string) {
  write(root, {
    "package.json": `${JSON.stringify({ name: "stand-in", private: true, scripts: { dev: "node servers.mjs" } })}\n`,
    "servers.mjs": [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      "const server = 'const fs = require(\"node:fs\"); require(\"node:net\").createServer().listen(0, \"127.0.0.1\", function () { fs.writeFileSync(\"port.part\", String(this.address().port)); fs.renameSync(\"port.part\", \"port\"); });';",
      'const child = spawn(process.execPath, ["-e", server], { stdio: "ignore" });',
      'fs.writeFileSync("pids", JSON.stringify([process.pid, child.pid]));',
      'for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {',
      "  process.on(signal, () => {",
      '    fs.appendFileSync("stops", `${signal}\\n`);',
      "    setTimeout(() => process.exit(0), 300);",
      "  });",
      "}",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  });
  const portFile = path.join(root, "port");
  const pidsFile = path.join(root, "pids");
  const stopsFile = path.join(root, "stops");
  return {
    async port(why = () => ""): Promise<number> {
      await vi.waitFor(() => expect(fs.existsSync(portFile), why()).toBe(true), { timeout: 30_000, interval: 100 });
      return Number(fs.readFileSync(portFile, "utf8"));
    },
    stops(): string[] {
      return fs.existsSync(stopsFile) ? fs.readFileSync(stopsFile, "utf8").split("\n").filter(Boolean) : [];
    },
    kill() {
      const pids: number[] = fs.existsSync(pidsFile) ? JSON.parse(fs.readFileSync(pidsFile, "utf8")) : [];
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Stopped already, as it should be.
        }
      }
    },
  };
}

/**
 * A stand-in for this checkout, for a mini-apps repository beside it: the
 * SDK's package.json, the `hearth-apps` command (copies of its bin and
 * tools, so that it takes the stand-in for the checkout it belongs to, and
 * writes its lists there) and the stand-in dev servers in place of the
 * framework's. The tools' own packages come from the SDK's node_modules, as
 * in deploy/tests/deploy.test.sh.
 */
function standInHearth() {
  const root = tempDir();
  const servers = standInServers(root);
  const sdk = path.join(root, "packages/sdk");
  fs.mkdirSync(path.join(sdk, "bin"), { recursive: true });
  fs.mkdirSync(path.join(sdk, "tools"), { recursive: true });
  fs.copyFileSync(path.join(SDK_DIR, "package.json"), path.join(sdk, "package.json"));
  fs.copyFileSync(BIN, path.join(sdk, "bin/hearth-apps.mjs"));
  for (const name of fs.readdirSync(path.join(SDK_DIR, "tools")).filter((file) => file.endsWith(".mjs"))) {
    fs.copyFileSync(path.join(SDK_DIR, "tools", name), path.join(sdk, "tools", name));
  }
  fs.symlinkSync(path.join(SDK_DIR, "node_modules"), path.join(sdk, "node_modules"), "dir");
  return { root, servers };
}

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
  it("stops every process below it when it is told to stop, not pnpm alone", { timeout: 60_000 }, async () => {
    const root = tempDir();
    const servers = standInServers(root);
    const signals = new EventEmitter();
    // Silent, so that pnpm's report of the stop it was given does not read like a failure in the log.
    const env = { ...process.env, npm_config_loglevel: "silent" };
    const running = startDevServers({ root, env, log: () => {}, signals });

    try {
      const port = await servers.port();
      expect(await listening(port)).toBe(true);

      signals.emit("SIGTERM", "SIGTERM");
      expect(await running).toBe(0);
      await vi.waitFor(async () => expect(await listening(port)).toBe(false), { timeout: 10_000, interval: 100 });
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      servers.kill();
    }
  });
});

describe("pnpm dev in a mini-apps repository", () => {
  /**
   * A9's `pnpm dev`, in a repository set up as hearth-stones is, beside a
   * stand-in for this checkout, started in a process group of its own as a
   * terminal starts it. `kill` ends whatever is left of it.
   */
  function startPnpmDev() {
    const hearth = standInHearth();
    const { stones, env } = setUpStones(hearth.root);
    const pnpm = spawn("pnpm", ["dev"], {
      cwd: stones,
      env: { ...env, npm_config_loglevel: "silent" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = pnpm.pid;
    if (pid === undefined) throw new Error("pnpm could not be started.");
    let output = "";
    pnpm.stdout.on("data", (data) => (output += data));
    pnpm.stderr.on("data", (data) => (output += data));
    let ended = false;
    pnpm.on("exit", () => (ended = true));
    return {
      pid,
      servers: hearth.servers,
      output: () => output,
      ended: () => ended,
      kill() {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // Its group is gone, as it should be.
        }
        hearth.servers.kill();
      },
    };
  }

  // Stopped as `kill` or a tool stops it: a signal to pnpm's own process,
  // not to its group. pnpm passes SIGTERM and SIGINT on to its script,
  // which `exec` makes the command itself, and dies of SIGHUP or SIGKILL,
  // after which the command finds that its parent is gone.
  it.each(["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const)(
    "stops the dev servers when pnpm alone is sent %s",
    { timeout: 60_000 },
    async (signal) => {
      const run = startPnpmDev();
      try {
        const port = await run.servers.port(run.output);
        expect(await listening(port)).toBe(true);
        expect(run.output()).toContain("hearth-apps dev: no mini-apps to run");

        process.kill(run.pid, signal);
        await vi.waitFor(async () => expect(await listening(port), run.output()).toBe(false), { timeout: 10_000, interval: 100 });
        await vi.waitFor(() => expect(run.ended()).toBe(true), { timeout: 10_000, interval: 100 });
      } finally {
        run.kill();
      }
    },
  );

  it("passes Ctrl+C on to the servers once, though it reaches the command twice", { timeout: 60_000 }, async () => {
    // A terminal sends Ctrl+C to its whole foreground group, pnpm and the
    // command, and pnpm passes its own on as well. Passed on twice, it
    // would make tsx kill the server before it has closed its database.
    const run = startPnpmDev();
    try {
      const port = await run.servers.port(run.output);
      process.kill(-run.pid, "SIGINT");
      await vi.waitFor(() => expect(run.ended(), run.output()).toBe(true), { timeout: 10_000, interval: 100 });
      expect(await listening(port)).toBe(false);
      expect(run.servers.stops()).toEqual(["SIGINT"]);
    } finally {
      run.kill();
    }
  });
});

describe("devEnvironment", () => {
  it("treats an empty owner as none", () => {
    expect(devEnvironment({ HEARTH_OWNER_EMAIL: "  " }, ["/apps"])).toMatchObject({ HEARTH_OWNER_EMAIL: DEV_OWNER_EMAIL });
  });
});
