/**
 * `<AppScope>`: what the shell puts around a mini-app's widget or page.
 *
 * It carries the space and the app, so that the app's own code never sees a
 * space ID and never builds an address. The app calls the hooks of
 * `appHooks` (`@hearth/sdk/web`); those read the value this component
 * provides, and everything behind them is here:
 *
 *  - `useApp()`: the reader, the space and its members, the access level,
 *    the app's settings in this space and `t` for its own strings.
 *  - `useQuery(name, input)`: POST .../q/:name. The component suspends until
 *    the first answer; `<AppView>` (./app-view.tsx) shows the skeleton and
 *    the failed state.
 *  - `useMutation(name)`: POST .../m/:name. A mutation that succeeded reads
 *    every query of this app in this space again, the settings included.
 *
 * Queries and settings are also read again when the window gets the focus
 * back and every 15 seconds while it is visible. That is how people in a
 * space see each other's changes; nothing is pushed.
 *
 * A `not_found` from any of these calls means the app is no longer there
 * for this person: removed, moved, or access taken away. The session is
 * then loaded again, and the card or page goes with the app.
 *
 * Design: docs/mini-app-contract.md, section A4.
 */
import type { Manifest } from "@hearth/sdk";
import { AppScopeContext, type AppInfo, type AppScopeValue, type MutationHandle } from "@hearth/sdk/web/scope";
import type { AppSettings, AppSummary, Locale } from "@hearth/shared";
import { useMutation, useQueryClient, useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { ApiRequestError, failureCode, type FailureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, appPath, useSession } from "../session/session";
import { callAppRoute, fetchAppSettings, type Install } from "./api";

/** How often an app's queries are read again while the window is visible. */
export const REFRESH_EVERY_MS = 15_000;

/** The key of everything cached for one app in one space; a query's and the settings' keys start with it. */
export function installQueryKey(install: Install): readonly [string, string, string] {
  return ["app", install.spaceId, install.appId];
}

/** What the scope keeps for the shell itself: which app this is, and where a failed change is reported. */
type ScopeInternals = Install & { reportFailure: (code: FailureCode | null) => void };

const InternalsContext = createContext<ScopeInternals | null>(null);

function useInternals(): ScopeInternals {
  const internals = useContext(InternalsContext);
  if (!internals) throw new Error("A mini-app's hooks only work inside <AppScope>.");
  return internals;
}

/** A dropped connection is worth two more tries. What the server refused or failed at is not: it would answer the same. */
function worthRetrying(failures: number, error: unknown): boolean {
  return failures < 2 && error instanceof ApiRequestError && error.code === "network";
}

const LIVE = {
  refetchInterval: REFRESH_EVERY_MS,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  retry: worthRetrying,
  retryDelay: 600,
} as const;

/**
 * Makes a call for an app. When the server says the app is not there, the
 * session is asked for again: it no longer lists the app, and the shell
 * stops drawing it. The failure itself is passed on unchanged.
 */
async function forApp<T>(client: QueryClient, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "not_found") {
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
    }
    throw error;
  }
}

/** The hook behind an app's `useQuery`. */
function useAppQuery(name: string, input: unknown): unknown {
  const { spaceId, appId } = useInternals();
  const client = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: [...installQueryKey({ spaceId, appId }), "q", name, input ?? null],
    queryFn: async ({ signal }) =>
      // A query always answers with something; null stands in so that the cache never holds "nothing yet".
      (await forApp(client, () => callAppRoute({ spaceId, appId, kind: "query", name, input, signal }))) ?? null,
    ...LIVE,
  });
  return data;
}

/** The hook behind an app's `useMutation`. */
function useAppMutation(name: string): MutationHandle {
  const { spaceId, appId, reportFailure } = useInternals();
  const client = useQueryClient();
  const { mutateAsync, isPending, error } = useMutation({
    mutationFn: (input: unknown) => forApp(client, () => callAppRoute({ spaceId, appId, kind: "mutation", name, input })),
    onMutate: () => reportFailure(null),
    // Waited for, so that `run` resolves when the screen shows the change. A failed re-read does not fail the change.
    onSuccess: () => client.invalidateQueries({ queryKey: installQueryKey({ spaceId, appId }) }),
    onError: (failure) => reportFailure(failureCode(failure)),
    retry: false,
  });
  return useMemo(
    () => ({
      run: (input?: unknown) => {
        const outcome = mutateAsync(input);
        // The shell reports a failure itself, so a caller that does not wait for the promise leaves nothing unhandled.
        outcome.catch(() => {});
        return outcome;
      },
      pending: isPending,
      error: error ? { code: failureCode(error) } : null,
    }),
    [mutateAsync, isPending, error],
  );
}

const NO_SETTINGS: AppSettings = { space: {}, user: {} };

/** The app's settings here, by name. Suspends until they are known; an app that declares none asks nothing. */
function useAppSettings(install: Install, manifest: Manifest): Record<string, unknown> {
  const declared = Object.keys(manifest.settings ?? {}).length > 0;
  const client = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: [...installQueryKey(install), "settings"],
    queryFn: ({ signal }) => (declared ? forApp(client, () => fetchAppSettings(install, signal)) : NO_SETTINGS),
    ...LIVE,
    refetchInterval: declared ? REFRESH_EVERY_MS : false,
    refetchOnWindowFocus: declared,
  });
  // A setting has one scope, so the two groups never hold the same name.
  return useMemo(() => ({ ...data.space, ...data.user }), [data]);
}

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * `t` for one app: its own strings in the reader's language, with
 * {placeholders} filled. A string missing in that language is given in
 * English, and a key the manifest does not have as the key itself, so that
 * a mistake shows on the screen and does not break it.
 */
export function appTranslator(manifest: Manifest, locale: Locale): AppInfo["t"] {
  const messages = manifest.messages;
  // Only what the manifest itself wrote: "constructor" is not one of an app's strings.
  const lookUp = (table: Readonly<Record<string, string>> | undefined, key: string) =>
    table && Object.hasOwn(table, key) ? table[key] : undefined;
  return (key, values) => {
    const text = lookUp(messages?.[locale], key) || lookUp(messages?.en, key) || key;
    if (!values) return text;
    return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
  };
}

export type AppScopeProps = {
  /** The app in its space, as the session lists it. */
  app: AppSummary;
  /** The app's manifest, from the build: its strings and its settings. */
  manifest: Manifest;
  /** Told the code of a change that failed, and null when another one starts. */
  onFailure?: (code: FailureCode | null) => void;
  children: ReactNode;
};

/** Gives the app's own code inside it what `appHooks` hands out. Suspends until the app's settings are known. */
export function AppScope({ app, manifest, onFailure, children }: AppScopeProps) {
  const { spaceId, id: appId } = app;
  const internals = useMemo<ScopeInternals>(
    () => ({ spaceId, appId, reportFailure: (code) => onFailure?.(code) }),
    [spaceId, appId, onFailure],
  );
  return (
    <InternalsContext value={internals}>
      <ScopeValue app={app} manifest={manifest}>
        {children}
      </ScopeValue>
    </InternalsContext>
  );
}

function ScopeValue({ app, manifest, children }: Pick<AppScopeProps, "app" | "manifest" | "children">) {
  const session = useSession();
  const { locale } = useI18n();
  const settings = useAppSettings({ spaceId: app.spaceId, appId: app.id }, manifest);

  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  const { id: userId, name: userName } = session.user;
  const { access, hasPage } = app;
  const pagePath = hasPage ? appPath(app) : null;

  const value = useMemo<AppScopeValue>(
    () => ({
      app: {
        t: appTranslator(manifest, locale),
        locale,
        user: { id: userId, name: userName },
        space: {
          kind: space?.kind ?? "personal",
          name: space?.name ?? "",
          members: (space?.members ?? []).map((member) => ({ id: member.id, name: member.name })),
        },
        access,
        canEdit: access === "edit",
        settings,
        pagePath,
      },
      useQuery: useAppQuery,
      useMutation: useAppMutation,
    }),
    [manifest, locale, userId, userName, space, access, settings, pagePath],
  );
  return <AppScopeContext value={value}>{children}</AppScopeContext>;
}
