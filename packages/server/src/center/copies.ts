/**
 * Finding published apps and adding copies of them (docs/center.md,
 * "Routes"): the center's list, a copy added to a space, and the publisher's
 * name beside a copy in the session.
 *
 * A copy is an ordinary made app of the space it is added to, made by
 * `createMadeApp` from the listing's snapshot: who may use it is VISIBLE's
 * to say, as for every app. Who sees a listing is `LISTED`'s
 * (center/published.ts).
 */
import type { AddCopyResult, AppSummary, Center, CenterListing, MemberAccess } from "@hearth/shared";
import type { Registry } from "../apps/registry";
import { addApp } from "../apps/installs";
import type { Db } from "../db/database";
import { listSpacesForUser, membershipOf } from "../db/people";
import { notFound, Refusal } from "../http/errors";
import { copiesOf, createMadeApp, nameOf } from "../made/apps";
import { inBoth } from "../made/manifest";
import { findListingFor, listListingsFor, publisherNamesFor } from "./published";

/** GET /api/center: the listings of every group the person is in, newest first, with who published each and what they may do. */
export function listCenter(db: Db, userId: string): Center {
  return db.transaction((): Center => {
    const owns = new Set(
      listSpacesForUser(db, userId)
        .filter((space) => space.kind === "group" && space.role === "owner")
        .map((space) => space.id),
    );
    const listings = listListingsFor(db, userId).map((listing): CenterListing => {
      const mine = listing.createdBy === userId;
      const { manifest } = listing;
      return {
        id: listing.id,
        spaceId: listing.spaceId,
        name: inBoth(manifest.name),
        description: inBoth(manifest.description),
        icon: manifest.icon,
        color: manifest.color,
        collections: Object.entries(manifest.collections).map(([name, collection]) => ({ name, fields: Object.keys(collection.fields) })),
        publishedBy: { id: listing.createdBy, name: listing.publisherName },
        revision: listing.revision,
        note: listing.note,
        updatedAt: listing.updatedAt,
        mine,
        // The same rule as unpublishing (center/publish.ts).
        canUnpublish: mine || owns.has(listing.spaceId),
      };
    });
    return { listings };
  })();
}

/** Version 1's note of a copy: what it is a copy of, in the words the model reads in its versions. */
export function copyNote(listing: { manifest: Parameters<typeof nameOf>[0]; revision: number }): string {
  return `Copy of “${nameOf(listing.manifest, "en")}” (revision ${listing.revision})`;
}

/**
 * POST /api/spaces/:spaceId/center/:id: adds a copy of a published app to
 * the group it is published to or to the person's own personal space, or
 * brings back the copy that space removed, with its data. One space holds
 * one copy of a published app.
 *
 * Throws a Refusal: 404 for a listing outside the person's groups (or none)
 * and for any other space; 403 when they may not add apps there; 409 when
 * the space holds a copy already, seen by them or not, and when a member
 * would bring back a removed one (`addApp`'s rule).
 */
export function addCopy(
  db: Db,
  registry: Registry,
  request: { userId: string; spaceId: string; id: string; memberAccess?: MemberAccess | undefined },
): AddCopyResult & { created: boolean } {
  const { userId, spaceId } = request;
  return db
    .transaction(() => {
      const listing = findListingFor(db, { userId, id: request.id });
      if (!listing) throw notFound();
      const member = membershipOf(db, userId, spaceId);
      // Where it was shared to, or the person's own space: nowhere else.
      if (!member || (spaceId !== listing.spaceId && member.kind !== "personal")) throw notFound();
      if (member.role !== "owner" && member.canAddApps !== 1) {
        throw new Refusal(403, "forbidden", "Adding apps to this space is for its owners and the members they allow.");
      }
      const copies = copiesOf(db, spaceId, listing.id);
      if (copies.some((copy) => !copy.removed)) throw new Refusal(409, "conflict", "This space has this app already.");
      const memberAccess = request.memberAccess === undefined ? {} : { memberAccess: request.memberAccess };
      const removed = copies.find((copy) => copy.removed);
      if (removed) {
        addApp(db, registry, { userId, spaceId, appId: removed.appId, ...memberAccess });
        return { appId: removed.appId, restored: true, created: false };
      }
      const { appId } = createMadeApp(db, registry, {
        userId,
        spaceId,
        manifest: listing.manifest,
        html: listing.html,
        origin: { id: listing.id, hash: listing.hash, revision: listing.revision },
        note: copyNote(listing),
        ...memberAccess,
      });
      return { appId, restored: false, created: true };
    })
    .immediate();
}

/**
 * The session's apps, with the publisher's name added to each copy whose
 * listing is in one of the person's groups: "by Lin" is shown only to those
 * who share that group with Lin.
 */
export function withPublishers(db: Db, userId: string, apps: AppSummary[]): AppSummary[] {
  const ids = apps.flatMap((app) => (app.source?.listingId === undefined ? [] : [app.source.listingId]));
  const names = publisherNamesFor(db, { userId, ids: [...new Set(ids)] });
  return apps.map((app) => {
    const by = app.source?.listingId === undefined ? undefined : names.get(app.source.listingId);
    return by === undefined ? app : { ...app, source: { ...app.source, by } };
  });
}
