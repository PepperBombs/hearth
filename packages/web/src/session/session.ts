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

/** Apps a person has switched on, which is what every screen lists. */
export function enabledApps(session: Session): AppSummary[] {
  return session.apps.filter((app) => app.enabled);
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
