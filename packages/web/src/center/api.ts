/**
 * What the app center (docs/center.md) asks the server: the apps published
 * to the person's groups, and unpublishing one; and, for the publish dialog
 * on an app's page, what would leave and publishing it. Which of the person's
 * spaces hold a copy already is read from the session
 * (`AppSummary.source.listingId`), never from here, so that only `VISIBLE`
 * on the server says which apps a person sees.
 *
 * Adding a copy is here too, though it changes a space and not the
 * center: what the center lists stays as it was.
 *
 * Shapes are in @hearth/shared; answers are checked against them.
 */
import {
  addCopyResultSchema,
  centerSchema,
  publishResultSchema,
  publishReviewSchema,
  type AddCopyResult,
  type CenterListing,
  type MemberAccess,
  type PublishResult,
  type PublishReview,
} from "@hearth/shared";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
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

/** Where an app's publish review is cached: it is asked for afresh each time the dialog opens. */
export function publishReviewKey(spaceId: string, appId: string): readonly [string, string, string, "publish"] {
  return ["app", spaceId, appId, "publish"];
}

const publishPath = (spaceId: string, appId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/apps/${encodeURIComponent(appId)}/publish`;

/**
 * GET .../publish: exactly what would leave, the groups it may go to, where
 * it is published already, and every problem that would refuse it. 403 for
 * someone who is not an owner of the app's space.
 */
export async function fetchPublishReview(spaceId: string, appId: string, signal?: AbortSignal): Promise<PublishReview> {
  const response = await request(publishPath(spaceId, appId), { signal });
  const parsed = publishReviewSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The publish review did not match the expected shape.");
  return parsed.data;
}

/** POST .../publish: publishes the app to a group, or publishes it there again. An empty note is left out. */
export async function publishApp(spaceId: string, appId: string, to: string, note: string): Promise<PublishResult> {
  const response = await request(publishPath(spaceId, appId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(note === "" ? { to } : { to, note }),
  });
  const parsed = publishResultSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The publish answer did not match the expected shape.");
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
 * when someone else unpublished it first. The publish dialog also has its
 * review read again (`alsoReread`), which lists where the app is published.
 */
export function useUnpublish(alsoReread?: QueryKey) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => unpublishListing(id),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: CENTER_QUERY_KEY }),
        client.invalidateQueries({ queryKey: SESSION_QUERY_KEY }),
        alsoReread ? client.invalidateQueries({ queryKey: alsoReread }) : undefined,
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

/** What publishing an app would send, where it may go and what refuses it; dropped once the dialog closes, so read afresh each time it opens. */
export function usePublishReview(spaceId: string, appId: string) {
  return useQuery({
    queryKey: publishReviewKey(spaceId, appId),
    queryFn: ({ signal }) => fetchPublishReview(spaceId, appId, signal),
    retry: worthRetrying,
    retryDelay: 600,
    gcTime: 0,
  });
}

export type PublishRequest = { to: string; note: string };

/**
 * Publishes an app to a group, or there again. Once the server has
 * answered, whatever it answered, the review is read again, so that the
 * dialog shows what refused it, and so is the center.
 */
export function usePublish(spaceId: string, appId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ to, note }: PublishRequest) => publishApp(spaceId, appId, to, note),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: publishReviewKey(spaceId, appId) }),
        client.invalidateQueries({ queryKey: CENTER_QUERY_KEY }),
      ]),
  });
}
