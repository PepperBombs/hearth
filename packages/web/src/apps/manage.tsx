/**
 * What a person does with an app as a whole, rather than inside it: add a
 * built-in app to a space, remove an app, move it to another space, switch
 * it on or off and pin it for themselves, and open its settings. The Apps
 * page uses all of them; the dashboard's cards and an app's page offer the
 * settings.
 *
 * After each change the session is loaded again, since every screen draws
 * its lists from it, whether the server made the change or turned it down:
 * a refusal usually means that the screen was out of date, for example
 * because someone else added or removed the app first. A switch or pin shows
 * at once, before the server has answered; if the server turns it down,
 * loading the session again puts the screen back to what is saved.
 */
import { IconButton } from "@hearth/sdk/web";
import type { AppPrefsPatch, AppSummary, MemberAccess, Session, Space } from "@hearth/shared";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { spaceAppsKey } from "../groups/queries";
import { pickLocalized } from "../i18n";
import { ApiRequestError } from "../session/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";
import { addFromCatalog, CATALOG_QUERY_KEY, fetchCatalog } from "../made/api";
import { moveAppToSpace, patchAppPrefs, removeAppFromSpace, type Install } from "./api";
import { hasSettings, settingsQueryKey } from "./settings";
import { AppSettingsDialog } from "./settings-dialog";

/** A dropped connection is worth two more tries; what the server refused or failed at is not. */
function worthRetrying(failures: number, error: unknown): boolean {
  return failures < 2 && error instanceof ApiRequestError && error.code === "network";
}

/** The apps shipped with Hearth, which the Add dialog offers. */
export function useCatalog() {
  return useQuery({
    queryKey: CATALOG_QUERY_KEY,
    queryFn: ({ signal }) => fetchCatalog(signal),
    staleTime: Infinity,
    retry: worthRetrying,
    retryDelay: 600,
  });
}

const installOf = (app: Pick<AppSummary, "id" | "spaceId">): Install => ({ spaceId: app.spaceId, appId: app.id });

/** The person's own switch and pin for one app in one space. */
export function useAppPrefs(app: AppSummary) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: AppPrefsPatch) => patchAppPrefs(installOf(app), patch),
    onMutate: async (patch) => {
      await client.cancelQueries({ queryKey: SESSION_QUERY_KEY });
      client.setQueryData<Session>(SESSION_QUERY_KEY, (session) =>
        session
          ? {
              ...session,
              apps: session.apps.map((other) => (other.spaceId === app.spaceId && other.id === app.id ? { ...other, ...patch } : other)),
            }
          : session,
      );
    },
    // Whether it was saved or not, the session says what is.
    onSettled: () => client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
  });
}

/**
 * Once the server has answered a change to a space's apps, whatever it
 * answered, the session and the space's owners' list are loaded again; the
 * change counts as finished when they are.
 */
function reloadAfter(client: QueryClient, spaceId: string) {
  return Promise.all([
    client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    client.invalidateQueries({ queryKey: spaceAppsKey(spaceId) }),
  ]);
}

export type AddRequest = { spaceId: string; templateId: string; memberAccess?: MemberAccess };

/**
 * Adds a built-in app to a space, as an app made in Hearth of the space's
 * own, or brings back the one the space removed, with its data.
 */
export function useAddApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, templateId, memberAccess }: AddRequest) => addFromCatalog(spaceId, templateId, memberAccess),
    onSettled: (_result, _error, { spaceId }) => reloadAfter(client, spaceId),
  });
}

/** Removes an app from a space; its data is kept. */
export function useRemoveApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (install: Install) => removeAppFromSpace(install),
    onSettled: (_result, _error, install) => reloadAfter(client, install.spaceId),
  });
}

export type MoveRequest = { install: Install; toSpaceId: string; memberAccess?: MemberAccess };

/**
 * Moves an app with its data to another space. Once the server has
 * answered, whether it moved the app or turned the move down, the session
 * and the owners' lists of both spaces are loaded again, and the move counts
 * as finished when they are: a refusal usually means that the screen was out
 * of date, for example because someone else moved the app first.
 */
export function useMoveApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ install, toSpaceId, memberAccess }: MoveRequest) =>
      moveAppToSpace(install, memberAccess === undefined ? { toSpaceId } : { toSpaceId, memberAccess }),
    onSettled: (_result, _error, { install, toSpaceId }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
        client.invalidateQueries({ queryKey: spaceAppsKey(install.spaceId) }),
        client.invalidateQueries({ queryKey: spaceAppsKey(toSpaceId) }),
      ]),
  });
}

/**
 * The spaces this person could move an app to, as the session tells: those
 * other than its own where they may add apps. Empty unless they own the
 * space the app is in. An app made in Hearth is in one space at a time, and
 * may go to either kind. The server decides again.
 */
export function useMoveTargets(app: AppSummary): Space[] {
  const session = useSession();
  const from = session.spaces.find((space) => space.id === app.spaceId);
  if (from?.role !== "owner") return [];
  return session.spaces.filter((space) => space.id !== app.spaceId && space.canAddApps);
}

/**
 * The app's name as a screen reader is given it where apps of the same name
 * may be listed in two spaces, as a built-in app added to both: in a group,
 * with the group's name ("Grocery list in Family").
 */
export function useFullAppName(app: AppSummary): string {
  const session = useSession();
  const { locale, t } = useI18n();
  const name = pickLocalized(app.name, locale);
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  return space?.kind === "group" ? t("dashboard.appInSpace", { app: name, space: space.name }) : name;
}

/**
 * The button that opens an app's settings, and the dialog behind it. Draws
 * nothing for an app that declares no settings.
 */
export function AppSettingsButton({ app, className }: { app: AppSummary; className?: string }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const fullName = useFullAppName(app);
  const [open, setOpen] = useState(false);
  if (!hasSettings(app)) return null;
  // The form starts from the first answer it is given. One kept from an earlier opening may be
  // old, since the app's pages read and save their settings through the bridge, not this cache:
  // it is asked for afresh, so that a save keeps what others saved since.
  const openDialog = () => {
    client.removeQueries({ queryKey: settingsQueryKey({ spaceId: app.spaceId, appId: app.id }), exact: true });
    setOpen(true);
  };
  return (
    <>
      <IconButton
        label={t("appSettings.open", { app: fullName })}
        aria-haspopup="dialog"
        className={className}
        onClick={openDialog}
      >
        <Settings2 size={16} aria-hidden="true" />
      </IconButton>
      <AppSettingsDialog app={app} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
