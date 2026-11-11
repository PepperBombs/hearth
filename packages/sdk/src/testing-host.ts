/**
 * `@hearth/sdk/testing/host`: how the framework hands `testApp` its
 * implementation.
 *
 * For the framework only; a mini-app does not import this (the import scan
 * refuses it). An app's tests call `testApp` from `@hearth/sdk/testing`,
 * which only forwards to what was installed here. The SDK holds no store
 * and no database: the framework installs the real ones, from the setup
 * file of the test run that `hearth-apps test` starts
 * (packages/server/src/apps/app-testing.setup.ts). A test of the SDK itself
 * may install a stand-in.
 *
 * Design: docs/mini-app-contract.md, section A9.
 */
import type { SpaceKind } from "./index";
import type { TestAppOptions, TestPerson } from "./testing";

/** What `as(...)` gives, before the app's own types are laid over it. */
export type TestCallerHandle = {
  readonly user: { readonly id: string; readonly name: string };
  /** `input` is undefined when the test passed none. */
  query(name: string, input?: unknown): unknown;
  mutation(name: string, input?: unknown): unknown;
  settings(): Record<string, unknown>;
  saveSettings(values: Record<string, unknown>): Record<string, unknown>;
};

/** What `testApp(server)` gives, before the app's own types are laid over it. */
export type TestAppHandle = {
  readonly space: { readonly kind: SpaceKind; readonly name: string };
  as(person?: TestPerson): TestCallerHandle;
};

/**
 * Makes a world for one app: a database of its own with the app in a
 * space. `server` is whatever the test passed, unchecked; the
 * implementation checks it as the server checks an app at start-up.
 */
export type TestAppImplementation = (server: unknown, options: TestAppOptions) => TestAppHandle;

let installed: TestAppImplementation | null = null;

/** Installs the implementation `testApp` forwards to, or takes it away with null. */
export function provideTestApp(implementation: TestAppImplementation | null): void {
  installed = implementation;
}

/** The implementation installed, or null when nothing supplies one. */
export function providedTestApp(): TestAppImplementation | null {
  return installed;
}
