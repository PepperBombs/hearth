/**
 * The tests of mini-apps, as `hearth-apps test` runs them
 * (packages/sdk/tools/test.mjs): inside this package, where the real store
 * and the database code live. Before each test file,
 * src/apps/app-testing.setup.ts gives `testApp` from `@hearth/sdk/testing`
 * the framework's implementation (src/apps/app-testing.ts).
 *
 * Which tests: HEARTH_APP_TESTS, set by the command, a JSON list of
 * `{ folder, apps }`: a folder of mini-apps (absolute) and the IDs of its
 * apps that have test files. Each folder is one project, named after it,
 * and runs the `*.test.*` files of those apps, leaving out what the import
 * scan does not read either (`node_modules`, names that start with a dot).
 *
 * This package's own tests are in vitest.config.ts. Without the variable
 * this file has nothing to run and says so. The command also sets TZ, so
 * that every app's tests run 8 hours from UTC, wherever they run.
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

type AppsToTest = { folder: string; apps: string[] };

function appsToTest(): AppsToTest[] {
  const value = process.env.HEARTH_APP_TESTS;
  if (!value) {
    throw new Error(
      'vitest.apps.config.ts runs the tests of mini-apps for "hearth-apps test", which names them in HEARTH_APP_TESTS. Run that command; this package\'s own tests are "pnpm test".',
    );
  }
  const parsed: unknown = JSON.parse(value);
  const valid =
    Array.isArray(parsed) &&
    parsed.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.folder === "string" &&
        path.isAbsolute(entry.folder) &&
        Array.isArray(entry.apps) &&
        entry.apps.every((id: unknown) => typeof id === "string" && /^[a-z][a-z0-9-]{1,30}$/.test(id)),
    );
  if (!valid) throw new Error("HEARTH_APP_TESTS must be a JSON list of { folder, apps }, as hearth-apps test writes it.");
  return parsed as AppsToTest[];
}

const TEST_FILES = "*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";

/** A project's name: the folder's own name, numbered when two folders share it. */
function names(folders: readonly AppsToTest[]): string[] {
  const seen = new Map<string, number>();
  return folders.map(({ folder }) => {
    const base = path.basename(folder);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

const folders = appsToTest();
const projectNames = names(folders);

export default defineConfig({
  root: import.meta.dirname,
  // Its own, so that a run of this package's own tests at the same time does not share it.
  cacheDir: "node_modules/.vite-app-tests",
  test: {
    environment: "node",
    setupFiles: [path.join(import.meta.dirname, "src/apps/app-testing.setup.ts")],
    projects: folders.map(({ folder, apps }, index) => ({
      test: {
        name: projectNames[index],
        dir: folder,
        include: apps.map((id) => `${id}/**/${TEST_FILES}`),
        exclude: ["**/node_modules/**", "**/.*/**", "**/.*"],
      },
    })),
  },
});
