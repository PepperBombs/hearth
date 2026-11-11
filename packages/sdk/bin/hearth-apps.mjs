#!/usr/bin/env node
/**
 * hearth-apps: the command that builds mini-apps into the framework, checks
 * them, tests them and runs them.
 *
 *   hearth-apps sync     Find the mini-apps and tell the framework to build them in.
 *                        Runs before every build and before `pnpm dev`.
 *   hearth-apps check    sync, then check every app: files, manifest, types, lint, tests.
 *   hearth-apps test     Run the apps' tests, inside the framework's server package.
 *   hearth-apps dev      sync, then the framework's dev servers with the apps in.
 *
 * Which folders hold the apps:
 *
 *   sync    the folders named in HEARTH_APPS_DIR (several are separated like
 *           PATH). Not set means no apps.
 *   check, test, dev
 *           the same, or the folder the command runs in when the variable is
 *           not set, which is how a mini-apps repository uses them.
 *
 * Exit status: 0 when all is well; 3 when a folder of apps was written for
 * another version of the SDK than this checkout holds; 1 for any other
 * problem with the apps; 2 for a command this does not know.
 *
 * `new` is part of the design (docs/mini-app-contract.md, sections A1 and
 * A9) and is not built yet.
 */
import process from "node:process";
import { check } from "../tools/check.mjs";
import { dev } from "../tools/dev.mjs";
import { AppsError, frameworkRoot, readAppsDirs, sync } from "../tools/sync.mjs";
import { test } from "../tools/test.mjs";

const USAGE = `Usage: hearth-apps <command>

  sync     Find the mini-apps in the folders named in HEARTH_APPS_DIR and
           write the lists the framework builds from. No folder, no apps.
  check    sync, then check every app: required files, manifests and server
           files, types, lint and tests.
  test     Run the apps' tests (*.test.ts), written with testApp from
           @hearth/sdk/testing, against the framework's own store.
  dev      sync, then Hearth on this machine with the apps in and sign-in
           switched off: http://localhost:5173.

Without HEARTH_APPS_DIR, check, test and dev work on the folder they are
run in.

Not built yet: new.`;

const NOT_BUILT = ["new"];

/** Reads `--out <dir>`, which sends the generated files somewhere else. The tests use it. */
function readOut(/** @type {string[]} */ args) {
  const at = args.indexOf("--out");
  if (at === -1) return { out: undefined, rest: args };
  const out = args[at + 1];
  if (!out) {
    console.error("hearth-apps: --out needs a folder.");
    process.exit(2);
  }
  return { out, rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}

const [command, ...args] = process.argv.slice(2);
const { out, rest } = readOut(args);
const root = frameworkRoot();

if (rest.length > 0 || command === undefined || command === "help" || command === "--help" || command === "-h") {
  console.error(USAGE);
  process.exit(command === undefined || rest.length > 0 ? 2 : 0);
}

/** The folders HEARTH_APPS_DIR names, or the one this runs in. */
const namedOrHere = () => {
  const named = readAppsDirs(process.env.HEARTH_APPS_DIR, root);
  return named.length > 0 ? named : [process.cwd()];
};

if (command === "sync") {
  try {
    const { apps, notices } = sync({ appsDirs: readAppsDirs(process.env.HEARTH_APPS_DIR, root), root, out });
    for (const notice of notices) console.error(`hearth-apps sync: ${notice}`);
    const names = apps.map((app) => app.id).join(", ");
    console.error(
      apps.length === 0
        ? "hearth-apps sync: this build holds no mini-apps."
        : `hearth-apps sync: this build holds ${apps.length === 1 ? "1 mini-app" : `${apps.length} mini-apps`} (${names}).`,
    );
  } catch (error) {
    if (!(error instanceof AppsError)) throw error;
    console.error("hearth-apps sync: the mini-apps cannot be built in. Nothing was written.");
    for (const problem of error.problems) console.error(`  - ${problem}`);
    process.exit(error.exitCode);
  }
} else if (command === "check") {
  process.exit(check({ appsDirs: namedOrHere(), root, out }));
} else if (command === "test") {
  // Writes nothing, so --out changes nothing.
  process.exit(test({ appsDirs: namedOrHere(), root }));
} else if (command === "dev") {
  if (out !== undefined) {
    console.error("hearth-apps dev: --out does not apply. The dev servers read the lists where sync writes them for a build.");
    process.exit(2);
  }
  process.exit(await dev({ appsDirs: namedOrHere(), root }));
} else if (NOT_BUILT.includes(command)) {
  console.error(`hearth-apps ${command} is not built yet. So far there are: sync, check, test, dev.`);
  process.exit(2);
} else {
  console.error(`hearth-apps: there is no command "${command}".\n\n${USAGE}`);
  process.exit(2);
}
