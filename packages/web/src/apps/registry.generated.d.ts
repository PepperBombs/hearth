/**
 * The types of registry.generated.js, the list of mini-apps this build of
 * the web app holds.
 *
 * `hearth-apps sync` (packages/sdk/tools/sync.mjs) writes the .js file
 * before every build and before `pnpm dev`, from the folders named in
 * HEARTH_APPS_DIR; it is not in Git. This file is, so that the type check
 * never needs the generated one and never walks into an app's code.
 *
 * Only main.tsx imports the registry.
 */
import type { BundledApp } from "./bundled";

export declare const apps: readonly BundledApp[];
