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
 *  - `useMutation(name)`: POST .../m/:name. Once the server has answered,
 *    whether it saved the change or turned it down, every query of this app
 *    in this space is read again, the settings included: a change that was
 *    turned down was often about something another person changed first.
 *    After a `not_found` the session is loaded first, and an app it no
 *    longer lists is not read again.
 *  - `useJob(name)`: GET .../jobs/:name, the job's status, which suspends
 *    the component until it is there, as a query does. It is read every 3
 *    seconds while a run is going on or was asked for, so that the end of
 *    the run shows soon after it comes. When the last run that went well is
 *    a later one than before, every query of the app here is read again
 *    before the new status is shown: the run brought new data, and the app
 *    never shows data older than its status says. `run()` is POST
 *    .../jobs/:name/run, whose answer is the status; it is refused and
 *    reported as a mutation is.
 *
 * Queries, settings and jobs' statuses are also read again when the window
 * gets the focus back and every 15 seconds while it is visible. That is how
 * people in a space see each other's changes; nothing is pushed.
 *
 * A `not_found` from any of these calls means the app is no longer there
 * for this person: removed, moved, or access taken away. The session is
 * then loaded again, and the card or page goes with the app.
 *
 * Design: docs/mini-app-contract.md, section A4, and for jobs section C
 * ("Hooks").
 */
import type { Manifest } from "@hearth/sdk";
import {
  AppScopeContext,
  type AppInfo,
  type AppScopeValue,
  type JobState,
  type MutationHandle,
} from "@hearth/sdk/web/scope";
import { jobStateOf, type AppSettings, type AppSummary, type JobStatus, type Locale, type Session } from "@hearth/shared";
import { useMutation, useQueryClient, useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { ApiRequestError, failureCode, type FailureCode } from "../session/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, appPath, useSession } from "../session/session";
import { callAppRoute, fetchAppSettings, fetchJobStatus, requestJobRun, type Install } from "./api";

/** How often an app's queries are read again while the window is visible. */
export const REFRESH_EVERY_MS = 15_000;
/** How often a job's status is read while a run is going on or was asked for. */
export const RUNNING_REFRESH_MS = 3_000;

/** The key of everything cached for one app in one space; a query's, the settings' and a job's keys start with it. */
export function installQueryKey(install: Install): readonly [string, string, string] {
  return ["app", install.spaceId, install.appId];
}

/** Where the answers of the app's queries in this space are cached: each one's key starts with this. */
function queriesKey(install: Install): readonly [string, string, string, "q"] {
  return [...installQueryKey(install), "q"];
}

/** Where the status of one of the app's jobs in this space is cached. */
function jobQueryKey(install: Install, job: string): readonly [string, string, string, "job", string] {
  return [...installQueryKey(install), "job", job];
}

/**
 * What the scope keeps for the shell itself: which app this is, whether the
 * person may change it, and where a failed change is reported.
 */
type ScopeInternals = Install & { canEdit: boolean; reportFailure: (code: FailureCode | null) => void };

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
export async function forApp<T>(client: QueryClient, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "not_found") {
      // Several of an app's calls fail together when it goes (a change, then the reads that follow it):
      // a reload of the session already on its way answers them all, so it is not started again.
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }, { cancelRefetch: false });
    }
    throw error;
  }
}

/** The hook behind an app's `useQuery`. */
function useAppQuery(name: string, input: unknown): unknown {
  const { spaceId, appId } = useInternals();
  const client = useQueryClient();
  const { data } = useSuspenseQuery({
    queryKey: [...queriesKey({ spaceId, appId }), name, input ?? null],
    queryFn: async ({ signal }) =>
      // A query always answers with something; null stands in so that the cache never holds "nothing yet".
      (await forApp(client, () => callAppRoute({ spaceId, appId, kind: "query", name, input, signal }))) ?? null,
    ...LIVE,
  });
  return data;
}

/**
 * After a change the server turned down, or that did not reach it: says so
 * under the app, and reads the app here again. A change the server turned
 * down (the item is gone, a conflict) leaves the screen showing what the
 * server no longer holds, so it is read again, and the caller settles once
 * it shows what is saved. Without an answer there is nothing new to read.
 */
async function afterFailedChange(
  client: QueryClient,
  { spaceId, appId }: Install,
  failure: unknown,
  reportFailure: ScopeInternals["reportFailure"],
): Promise<void> {
  const code = failureCode(failure);
  reportFailure(code);
  if (code === "network") return;
  // A not_found may be about the app itself (removed, access taken away) or only about a row in it. The
  // session reload it started is waited for, and an app the session no longer lists is not read again.
  if (code === "not_found") {
    await client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }, { cancelRefetch: false });
    const listed = client
      .getQueryData<Session>(SESSION_QUERY_KEY)
      ?.apps.some((app) => app.spaceId === spaceId && app.id === appId && app.enabled);
    if (!listed) return;
  }
  await client.invalidateQueries({ queryKey: installQueryKey({ spaceId, appId }) });
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
    onError: (failure) => afterFailedChange(client, { spaceId, appId }, failure, reportFailure),
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

/**
 * Takes a job's status that has just come from the server, before it is
 * cached and shown. When the last run that went well is not the one the
 * cached status named, that run brought new data: every query of the app
 * here is read again first, so that the app never shows data older than
 * its status says. The first status of all has nothing to compare with.
 */
async function received(client: QueryClient, install: Install, job: string, status: JobStatus): Promise<JobStatus> {
  const before = client.getQueryData<JobStatus>(jobQueryKey(install, job));
  if (before !== undefined && before.lastSucceededAt !== status.lastSucceededAt) {
    // A failed re-read leaves the queries as they were; they are read again at their next turn.
    await client.invalidateQueries({ queryKey: queriesKey(install) });
  }
  return status;
}

/** The hook behind an app's `useJob`. */
function useAppJob(name: string): JobState {
  const { spaceId, appId, canEdit, reportFailure } = useInternals();
  const client = useQueryClient();
  const { data: status } = useSuspenseQuery({
    queryKey: jobQueryKey({ spaceId, appId }, name),
    queryFn: async ({ signal }) => {
      const install = { spaceId, appId };
      return received(client, install, name, await forApp(client, () => fetchJobStatus(install, name, signal)));
    },
    ...LIVE,
    // More often while a run is going on or was asked for, so that its end shows soon after it comes.
    refetchInterval: (query) => (query.state.data && jobStateOf(query.state.data).running ? RUNNING_REFRESH_MS : REFRESH_EVERY_MS),
  });
  const { mutateAsync, isPending } = useMutation({
    mutationFn: () => forApp(client, () => requestJobRun({ spaceId, appId }, name)),
    onMutate: () => reportFailure(null),
    // The answer is the status with the run asked for. A reading of the status sent before the request
    // would put back the job as it was, so one on its way is called off first.
    onSuccess: async (answer) => {
      const install = { spaceId, appId };
      await client.cancelQueries({ queryKey: jobQueryKey(install, name) });
      client.setQueryData(jobQueryKey(install, name), await received(client, install, name, answer));
    },
    // Refused or not sent: reported and read again as a mutation is.
    onError: (failure) => afterFailedChange(client, { spaceId, appId }, failure, reportFailure),
    retry: false,
  });
  const run = useCallback(() => {
    const outcome = mutateAsync().then(() => undefined);
    // The shell reports a failure itself, so a caller that does not wait for the promise leaves nothing unhandled.
    outcome.catch(() => {});
    return outcome;
  }, [mutateAsync]);
  return useMemo(() => ({ ...jobStateOf(status), canRun: canEdit, run, pending: isPending }), [status, canEdit, run, isPending]);
}

const NO_SETTINGS: AppSettings = { space: {}, user: {} };

/** Whether the app declares any settings. One that declares none is never asked for them. */
export function hasSettings(manifest: Manifest): boolean {
  return Object.keys(manifest.settings ?? {}).length > 0;
}

/** Where the app's settings in this space are cached, below the key of everything cached for the app. */
export function settingsQueryKey(install: Install): readonly [string, string, string, "settings"] {
  return [...installQueryKey(install), "settings"];
}

/**
 * How the app's settings are read: by `<AppScope>` for the app's own code,
 * and by the settings dialog, which shares the same cached answer.
 */
export function settingsQuery(client: QueryClient, install: Install, manifest: Manifest) {
  const declared = hasSettings(manifest);
  return {
    queryKey: settingsQueryKey(install),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      declared ? forApp(client, () => fetchAppSettings(install, signal)) : Promise.resolve(NO_SETTINGS),
    ...LIVE,
    refetchInterval: declared ? REFRESH_EVERY_MS : false,
    refetchOnWindowFocus: declared,
  } as const;
}

/** The app's settings here, by name. Suspends until they are known; an app that declares none asks nothing. */
function useAppSettings(install: Install, manifest: Manifest): Record<string, unknown> {
  const client = useQueryClient();
  const { data } = useSuspenseQuery(settingsQuery(client, install, manifest));
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
  const canEdit = app.access === "edit";
  const internals = useMemo<ScopeInternals>(
    () => ({ spaceId, appId, canEdit, reportFailure: (code) => onFailure?.(code) }),
    [spaceId, appId, canEdit, onFailure],
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
      useJob: useAppJob,
    }),
    [manifest, locale, userId, userName, space, access, settings, pagePath],
  );
  return <AppScopeContext value={value}>{children}</AppScopeContext>;
}
