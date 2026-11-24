/**
 * What the app center (docs/center.md) asks the server: the apps published
 * to the person's groups, and unpublishing one. Which of the person's
 * spaces hold a copy already is read from the session
 * (`AppSummary.source.listingId`), never from here, so that only `VISIBLE`
 * on the server says which apps a person sees.
 *
 * Adding a copy is here too, though it changes a space and not the
 * center: what the center lists stays as it was.
 *
 * Shapes are in @hearth/shared; answers are checked against them.
 */
import { addCopyResultSchema, centerSchema, type AddCopyResult, type CenterListing, type MemberAccess } from "@hearth/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { spaceAppsKey } from "../groups/queries";
import { ApiRequestError, request } from "../session/api";
import { SESSION_QUERY_KEY } from "../session/session";

export const CENTER_QUERY_KEY = ["center"] as const;

/** GET /api/center: the published apps of every group the person is in, the newest first. */
export async function fetchCenter(signal?: AbortSignal): Promise<CenterListing[]> {
  const response = await request("/api/center", { signal });
  const parsed = centerSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The app center did not match the expected shape.");
  return parsed.data.listings;
}

/** DELETE /api/center/:id: unpublishes an app. Its copies keep working. No body comes back. */
export async function unpublishListing(id: string): Promise<void> {
  await request(`/api/center/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/**
 * POST /api/spaces/:spaceId/center/:id: adds a copy of a published app to a
 * space, or brings back the copy the space removed (`restored`), with its
 * data. `memberAccess` is for a group alone.
 */
export async function addCopy(spaceId: string, id: string, memberAccess?: MemberAccess): Promise<AddCopyResult> {
  const response = await request(`/api/spaces/${encodeURIComponent(spaceId)}/center/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(memberAccess === undefined ? {} : { memberAccess }),
  });
  const parsed = addCopyResultSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The added copy did not match the expected shape.");
  return parsed.data;
}

/** A dropped connection is worth two more tries; what the server refused or failed at is not. */
function worthRetrying(failures: number, error: unknown): boolean {
  return failures < 2 && error instanceof ApiRequestError && error.code === "network";
}

/** The published apps of the person's groups, asked for afresh each time the center is opened. */
export function useCenter() {
  return useQuery({
    queryKey: CENTER_QUERY_KEY,
    queryFn: ({ signal }) => fetchCenter(signal),
    retry: worthRetrying,
    retryDelay: 600,
  });
}

/**
 * Unpublishes an app. Once the server has answered, whatever it answered,
 * the center is read again, and so is the session, whose copies of the app
 * no longer name it: a refusal usually means the page was out of date, as
 * when someone else unpublished it first.
 */
export function useUnpublish() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unpublishListing(id),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: CENTER_QUERY_KEY }),
        client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
      ]),
  });
}

export type AddCopyRequest = { spaceId: string; id: string; memberAccess?: MemberAccess | undefined };

/**
 * Adds a copy of a published app to a space. Once the server has answered,
 * whatever it answered, the session and the space's owners' list are read
 * again, as for any app added (apps/manage.tsx): the mutation settles only
 * then, so the new copy is in the session by the time "Open" and "Change it
 * in the chat" are offered, and the chat finds it to name.
 */
export function useAddCopy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ spaceId, id, memberAccess }: AddCopyRequest) => addCopy(spaceId, id, memberAccess),
    onSettled: (_result, _error, { spaceId }) =>
      Promise.all([
        client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
        client.invalidateQueries({ queryKey: spaceAppsKey(spaceId) }),
      ]),
  });
}
