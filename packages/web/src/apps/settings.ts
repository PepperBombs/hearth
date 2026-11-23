/**
 * An app's settings in one space, as the settings dialog reads them: what
 * the app declares, as the session describes its manifest, and the values
 * the server holds, the space's and the person's own. An app's page reads
 * and saves them through its bridge (../made/frame.tsx), never through this
 * cache.
 */
import type { Setting } from "@hearth/sdk";
import type { AppSummary } from "@hearth/shared";
import type { QueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../session/api";
import { SESSION_QUERY_KEY } from "../session/session";
import { fetchAppSettings, type Install } from "./api";

/**
 * The settings an app declares, by name, as an SDK manifest declares them.
 * The server checked them by the SDK's own rules before the session listed
 * the app (docs/platform.md, "An app made in Hearth").
 */
export function declaredSettings(app: Pick<AppSummary, "settings">): Readonly<Record<string, Setting>> {
  return (app.settings ?? {}) as Record<string, Setting>;
}

/** Whether the app declares any settings. One that declares none has no settings to open. */
export function hasSettings(app: Pick<AppSummary, "settings">): boolean {
  return Object.keys(declaredSettings(app)).length > 0;
}

/** Where the app's settings in this space are cached. */
export function settingsQueryKey(install: Install): readonly [string, string, string, "settings"] {
  return ["app", install.spaceId, install.appId, "settings"];
}

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
      // A reload of the session already on its way answers this one too, so it is not started again.
      void client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }, { cancelRefetch: false });
    }
    throw error;
  }
}

/** A dropped connection is worth two more tries. What the server refused or failed at is not: it would answer the same. */
function worthRetrying(failures: number, error: unknown): boolean {
  return failures < 2 && error instanceof ApiRequestError && error.code === "network";
}

/** How the settings dialog reads an app's settings in a space. */
export function settingsQuery(client: QueryClient, install: Install) {
  return {
    queryKey: settingsQueryKey(install),
    queryFn: ({ signal }: { signal: AbortSignal }) => forApp(client, () => fetchAppSettings(install, signal)),
    retry: worthRetrying,
    retryDelay: 600,
  } as const;
}
