/**
 * The routes for groups and their members (docs/mini-app-contract.md,
 * section A8): create a group, rename it, add someone, change what a member
 * may do, remove a member or leave, and take back an invitation. The
 * request shapes are in `@hearth/shared`. Creating a group and adding
 * someone answer with a body; after the others the web app reloads what it
 * shows.
 */
import {
  addMemberRequestSchema,
  createSpaceRequestSchema,
  memberPatchSchema,
  spacePatchSchema,
  withdrawInvitationRequestSchema,
  type AddMemberResponse,
  type Space,
} from "@hearth/shared";
import type { Hono } from "hono";
import type { Config } from "../config";
import type { Db } from "../db/database";
import { readBody } from "../http/body";
import type { Env, RequireMember } from "../http/env";
import { addMember, changeMember, createGroup, removeMember, renameGroup, withdrawInvitation } from "./members";
import { groupRights } from "./policy";

export type GroupRoutesOptions = { db: Db; config: Config; requireMember: RequireMember };

/** Adds the routes to the application. Call it before the catch-all for unknown `/api` paths. */
export function registerGroupRoutes(app: Hono<Env>, options: GroupRoutesOptions): void {
  const { db, config, requireMember } = options;

  // Create a group, with the person asking as its owner.
  app.post("/api/spaces", requireMember, async (c) => {
    const { name } = await readBody(c, createSpaceRequestSchema);
    const user = c.get("user");
    const space: Space = createGroup(db, groupRights(config, user), { userId: user.id, name });
    return c.json(space, 201);
  });

  // Rename a group.
  app.patch("/api/spaces/:spaceId", requireMember, async (c) => {
    const { name } = await readBody(c, spacePatchSchema);
    renameGroup(db, { userId: c.get("user").id, spaceId: c.req.param("spaceId"), name });
    return c.body(null, 204);
  });

  // Add someone by their address: a member at once if they are on the server, else invited.
  app.post("/api/spaces/:spaceId/members", requireMember, async (c) => {
    const request = await readBody(c, addMemberRequestSchema);
    const user = c.get("user");
    const outcome = addMember(db, groupRights(config, user), { userId: user.id, spaceId: c.req.param("spaceId"), ...request });
    return c.json({ outcome } satisfies AddMemberResponse);
  });

  // Change a member's role, or whether they may add apps.
  app.patch("/api/spaces/:spaceId/members/:memberId", requireMember, async (c) => {
    const patch = await readBody(c, memberPatchSchema);
    const { spaceId, memberId } = c.req.param();
    changeMember(db, { userId: c.get("user").id, spaceId, memberId, patch });
    return c.body(null, 204);
  });

  // Remove a member, or leave: an owner may remove anyone, anyone may remove themselves.
  app.delete("/api/spaces/:spaceId/members/:memberId", requireMember, (c) => {
    const { spaceId, memberId } = c.req.param();
    removeMember(db, { userId: c.get("user").id, spaceId, memberId });
    return c.body(null, 204);
  });

  // Take back the invitation of someone who has not arrived yet. The address
  // travels in the body, not in the address of the request, which proxies log.
  app.delete("/api/spaces/:spaceId/invitations", requireMember, async (c) => {
    const { email } = await readBody(c, withdrawInvitationRequestSchema);
    withdrawInvitation(db, { userId: c.get("user").id, spaceId: c.req.param("spaceId"), email });
    return c.body(null, 204);
  });
}
