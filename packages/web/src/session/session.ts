import { createContext, useContext } from "react";
import type { AppSummary, Session, Space } from "@hearth/shared";

export const SESSION_QUERY_KEY = ["session"] as const;

export const SessionContext = createContext<Session | null>(null);

/** The signed-in person, their spaces and their apps. Only usable inside the shell. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside <SessionGate>");
  return session;
}

export type SpaceWithApps = { space: Space; apps: AppSummary[] };

/**
 * The apps in the order every screen lists them: those the person pinned
 * first, then the rest, each part in the order the server sent them.
 */
export function pinnedFirst(apps: readonly AppSummary[]): AppSummary[] {
  return [...apps.filter((app) => app.pinned), ...apps.filter((app) => !app.pinned)];
}

/**
 * Apps a person has switched on, which is what every screen lists, pinned
 * ones first. Only the Apps page lists the others, so that they can be
 * switched back on.
 */
export function enabledApps(session: Session): AppSummary[] {
  return pinnedFirst(session.apps.filter((app) => app.enabled));
}

/**
 * Enabled apps split the way every screen groups them: those in the person's
 * own space, then one entry per group space in the order the server sent them.
 */
export function spacesWithApps(session: Session): { personal: AppSummary[]; groups: SpaceWithApps[] } {
  const apps = enabledApps(session);
  const personalIds = new Set(session.spaces.filter((space) => space.kind === "personal").map((space) => space.id));
  return {
    personal: apps.filter((app) => personalIds.has(app.spaceId)),
    groups: session.spaces
      .filter((space) => space.kind === "group")
      .map((space) => ({ space, apps: apps.filter((app) => app.spaceId === space.id) })),
  };
}

/** Where an app's own page lives in the shell. */
export function appPath(app: Pick<AppSummary, "id" | "spaceId">): string {
  return `/apps/${encodeURIComponent(app.spaceId)}/${encodeURIComponent(app.id)}`;
}
