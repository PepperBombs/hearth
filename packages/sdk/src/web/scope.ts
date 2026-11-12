/**
 * `@hearth/sdk/web/scope`: what the shell hands a mini-app's widget or page.
 *
 * For the framework only; a mini-app does not import this (the import scan
 * refuses it). An app's code calls the hooks of `appHooks` in
 * `@hearth/sdk/web`, and those read the one value below from React's
 * context. The SDK holds no way to fetch anything: whoever draws the widget
 * supplies it. In the web app that is `<AppScope>` (packages/web/src/apps),
 * which knows the space and the app and talks to the server; a test may
 * supply a stand-in.
 *
 * Design: docs/mini-app-contract.md, section A4.
 */
import { createContext } from "react";
import type { Locale, SpaceKind } from "../index";
import type { JobState } from "../routes";

export type { JobState };

/** What `useApp()` returns, before the app's own types are laid over it. */
export type AppInfo = {
  /** Looks one of the app's interface strings up in the reader's language and fills its {placeholders}. */
  t(key: string, values?: Record<string, string | number>): string;
  /** The language the reader has chosen. */
  locale: Locale;
  /** The signed-in person. */
  user: { id: string; name: string };
  /** The space the app is in. A personal space has an empty name. There is no ID. */
  space: { kind: SpaceKind; name: string; members: { id: string; name: string }[] };
  /** What the person may do with the app here. */
  access: "view" | "edit";
  /** Whether `access` is "edit": mutations are refused without it. */
  canEdit: boolean;
  /** Every setting by name: the space's value, the person's own, or the default. */
  settings: Record<string, unknown>;
  /** The address of the app's own page inside the shell, or null when it has none. */
  pagePath: string | null;
};

/** What `useMutation(name)` returns, before the route's types are laid over it. */
export type MutationHandle = {
  /**
   * Calls the mutation. The promise settles once the answer is in and the
   * app's queries have been read again; it rejects when the mutation was
   * refused or failed. A caller that does not wait for it need not catch it.
   */
  run(input?: unknown): Promise<unknown>;
  /** True from the call until the promise settles. */
  pending: boolean;
  /** Why the last call failed, or null. `code` is one of the server's error codes, or "network". */
  error: { code: string } | null;
};

/**
 * Everything a widget or page can reach. `useQuery`, `useMutation` and
 * `useJob` are hooks: they are called while the app's component renders,
 * so a provider must hand over the same three functions for as long as it
 * is mounted.
 */
export type AppScopeValue = {
  app: AppInfo;
  /** Gives the answer of a query, and suspends the component until there is one. */
  useQuery(name: string, input: unknown): unknown;
  useMutation(name: string): MutationHandle;
  /** Gives how one of the app's jobs is doing here, and suspends the component until its status is known. */
  useJob(name: string): JobState;
};

export const AppScopeContext = createContext<AppScopeValue | null>(null);
