/**
 * The calls the shell makes about groups, the people in them and who can
 * use which app (docs/mini-app-contract.md, section A8). Shapes are in
 * @hearth/shared; answers that carry a body are checked against them.
 * Routes without a body in their answer are followed by loading the
 * session (and the owners' list) again.
 */
import {
  addMemberResponseSchema,
  spaceAppsSchema,
  spaceSchema,
  type AddMemberRequest,
  type AddMemberResponse,
  type AppAccessRequest,
  type MemberPatch,
  type Space,
  type SpaceApps,
} from "@hearth/shared";
import { ApiRequestError, request } from "../session/api";

const JSON_HEADERS = { "Content-Type": "application/json" };

function spaceAddress(spaceId: string, rest = ""): string {
  const base = `/api/spaces/${encodeURIComponent(spaceId)}`;
  return rest === "" ? base : `${base}/${rest}`;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/** POST /api/spaces: creates a group with the person as its owner, and answers with it. */
export async function createGroup(name: string): Promise<Space> {
  const response = await request("/api/spaces", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
  const parsed = spaceSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The new group did not match the expected shape.");
  return parsed.data;
}

/** PATCH /api/spaces/:spaceId: renames a group. */
export async function renameGroup(spaceId: string, name: string): Promise<void> {
  await request(spaceAddress(spaceId), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
}

/** POST .../members: adds someone on the server at once, or invites an address that is not. */
export async function addMember(spaceId: string, body: AddMemberRequest): Promise<AddMemberResponse> {
  const response = await request(spaceAddress(spaceId, "members"), { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  const parsed = addMemberResponseSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The answer did not match the expected shape.");
  return parsed.data;
}

/** PATCH .../members/:userId: a member's role, or whether they may add apps. */
export async function changeMember(spaceId: string, memberId: string, patch: MemberPatch): Promise<void> {
  await request(spaceAddress(spaceId, `members/${encodeURIComponent(memberId)}`), {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
}

/** DELETE .../members/:userId: removes a member, or, for the person's own ID, leaves the group. */
export async function removeMember(spaceId: string, memberId: string): Promise<void> {
  await request(spaceAddress(spaceId, `members/${encodeURIComponent(memberId)}`), { method: "DELETE" });
}

/** DELETE .../invitations: takes back the invitation of someone who has not arrived yet. */
export async function withdrawInvitation(spaceId: string, email: string): Promise<void> {
  await request(spaceAddress(spaceId, "invitations"), { method: "DELETE", headers: JSON_HEADERS, body: JSON.stringify({ email }) });
}

/** GET .../apps: the owners' list of the space's apps, who can use each, and everyone in it. */
export async function fetchSpaceApps(spaceId: string, signal?: AbortSignal): Promise<SpaceApps> {
  const response = await request(spaceAddress(spaceId, "apps"), { signal });
  const parsed = spaceAppsSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new ApiRequestError("invalid_response", response.status, "The list of the space's apps did not match the expected shape.");
  return parsed.data;
}

/** PUT .../apps/:appId/access: what every member gets, and exceptions for single members. */
export async function setAppAccess(spaceId: string, appId: string, body: AppAccessRequest): Promise<void> {
  await request(spaceAddress(spaceId, `apps/${encodeURIComponent(appId)}/access`), {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}
