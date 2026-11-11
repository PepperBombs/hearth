/**
 * What the group cards in Settings read and how they change things. The
 * session says which groups a person is in and who is in each; owners also
 * read the owners' list (GET /api/spaces/:spaceId/apps): addresses, who may
 * add apps, invitations and who can use each app. After every change both
 * are loaded again, since every screen draws from them.
 */
import type { Space } from "@hearth/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError } from "../session/api";
import { SESSION_QUERY_KEY } from "../session/session";
import { fetchSpaceApps } from "./api";

/** The key of a space's owners' list in the cache. */
export function spaceAppsKey(spaceId: string): readonly [string, string] {
  return ["space-apps", spaceId];
}

/** A dropped connection is worth two more tries; what the server refused is not. */
function worthRetrying(failures: number, error: unknown): boolean {
  return failures < 2 && error instanceof ApiRequestError && error.code === "network";
}

/** The owners' list of a group. Only asked for while the person owns the group: it is theirs alone. */
export function useSpaceApps(space: Space) {
  return useQuery({
    queryKey: spaceAppsKey(space.id),
    queryFn: ({ signal }) => fetchSpaceApps(space.id, signal),
    enabled: space.role === "owner",
    retry: worthRetrying,
    retryDelay: 600,
  });
}

/**
 * A change to a group, or the creation of one (`spaceId` null). Once the
 * server has answered, whether it made the change or turned it down, the
 * session and the group's owners' list are loaded again; the change counts
 * as finished when they are, so that the screen already shows what is saved.
 */
export function useGroupChange<Input, Result = void>(spaceId: string | null, change: (input: Input) => Promise<Result>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: change,
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
        spaceId === null ? null : client.invalidateQueries({ queryKey: spaceAppsKey(spaceId) }),
      ]),
  });
}
