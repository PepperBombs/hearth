/**
 * The types of registry.generated.js, the list of mini-apps this build
 * holds.
 *
 * `hearth-apps sync` (packages/sdk/tools/sync.mjs) writes the .js file
 * before every build and before `pnpm dev`, from the folders named in
 * HEARTH_APPS_DIR; it is not in Git. This file is, so that the type check
 * never needs the generated one and never walks into an app's code.
 *
 * Only main.ts imports the registry. Everything else is handed the list, and
 * tests hand over their own.
 */
import type { BundledApp } from "./registry";

export declare const apps: readonly BundledApp[];
