/**
 * Run by `hearth-apps check` (packages/sdk/tools/check.mjs), not by the
 * server: checks the mini-apps in a generated registry the way the server
 * does when it starts, and says what is wrong with them.
 *
 *     tsx src/apps/check-bundle.ts <path of a registry.generated.js>
 *
 * It is the same `createRegistry` that stops a server with a bad app, so an
 * app that passes here will not fail a deploy's trial start for this reason.
 * Exit status 1 when an app is not valid.
 */
import { pathToFileURL } from "node:url";
import { AppRegistryError, createRegistry, type BundledApp } from "./registry";

const file = process.argv[2];
if (!file) {
  console.error("check-bundle: name the registry file to check.");
  process.exit(2);
}

const { apps } = (await import(pathToFileURL(file).href)) as { apps: readonly BundledApp[] };

try {
  createRegistry(apps);
} catch (error) {
  if (!(error instanceof AppRegistryError)) throw error;
  console.error("hearth-apps check: a mini-app is not valid.");
  for (const problem of error.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
