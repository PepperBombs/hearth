/**
 * What a person does with an app as a whole, rather than inside it: add it
 * to a space, remove it, move it to another space, switch it on or off and
 * pin it for themselves, and open its settings. The Apps page uses all of
 * them; the dashboard's cards and an app's page offer the settings.
 *
 * After each change the session is loaded again, since every screen draws
 * its lists from it, whether the server made the change or turned it down:
 * a refusal usually means that the screen was out of date, for example
 * because someone else added or removed the app first. A switch or pin shows
 * at once, before the server has answered; if the server turns it down,
 * loading the session again puts the screen back to what is saved.
 */
import type { Manifest } from "@hearth/sdk";
import { IconButton } from "@hearth/sdk/web";
import type { AppPrefsPatch, AppSummary, MemberAccess, Session, Space } from "@hearth/shared";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Settings2 } from "lucide-react";
import { useState } from "react";
import { spaceAppsKey } from "../groups/queries";
import { pickLocalized } from "../i18n";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";
import { addAppToSpace, moveAppToSpace, patchAppPrefs, removeAppFromSpace, type Install } from "./api";
import { useBundledApps } from "./bundled";
import { hasSettings } from "./scope";
import { AppSettingsDialog } from "./settings-dialog";

/** The manifest this build holds for an app, or null when it holds none (the browser has an older build). */
export function useBundledManifest(appId: string): Manifest | null {
  return useBundledApps().find((candidate) => candidate.id === appId)?.manifest ?? null;
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
function reloadAfter(client: QueryClient, install: Install) {
  return Promise.all([
    client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
    client.invalidateQueries({ queryKey: spaceAppsKey(install.spaceId) }),
  ]);
}

/** Adds an app to a space, or brings a removed one back with its data. */
export function useAddApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ install, memberAccess }: { install: Install; memberAccess?: MemberAccess }) =>
      addAppToSpace(install, memberAccess === undefined ? {} : { memberAccess }),
    onSettled: (_result, _error, { install }) => reloadAfter(client, install),
  });
}

/** Removes an app from a space; its data is kept. */
export function useRemoveApp() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (install: Install) => removeAppFromSpace(install),
    onSettled: (_result, _error, install) => reloadAfter(client, install),
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
 * other than its own where they may add apps, whose kind the app's manifest
 * allows, and which do not list the app already. Empty unless they own the
 * space the app is in. The server decides again; a space that holds the app
 * hidden from this person, or kept its data from before, turns the move down.
 */
export function useMoveTargets(app: AppSummary): Space[] {
  const session = useSession();
  const manifest = useBundledManifest(app.id);
  const from = session.spaces.find((space) => space.id === app.spaceId);
  if (from?.role !== "owner") return [];
  return session.spaces.filter(
    (space) =>
      space.id !== app.spaceId &&
      space.canAddApps &&
      (!manifest?.spaces || manifest.spaces.includes(space.kind)) &&
      !session.apps.some((other) => other.spaceId === space.id && other.id === app.id),
  );
}

/**
 * The app's name as a screen reader is given it where the same app may be
 * listed twice: in a group, with the group's name ("Checklist in Family").
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
 * nothing for an app that declares no settings, or that this build lacks.
 */
export function AppSettingsButton({ app, className }: { app: AppSummary; className?: string }) {
  const { t } = useI18n();
  const manifest = useBundledManifest(app.id);
  const fullName = useFullAppName(app);
  const [open, setOpen] = useState(false);
  if (!manifest || !hasSettings(manifest)) return null;
  return (
    <>
      <IconButton
        label={t("appSettings.open", { app: fullName })}
        aria-haspopup="dialog"
        className={className}
        onClick={() => setOpen(true)}
      >
        <Settings2 size={16} aria-hidden="true" />
      </IconButton>
      <AppSettingsDialog app={app} manifest={manifest} open={open} onClose={() => setOpen(false)} />
    </>
  );
}
