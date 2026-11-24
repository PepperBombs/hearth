/**
 * The app center (docs/center.md): the table `published_apps`, the apps
 * published to a group. A published app (a listing) is a snapshot of one
 * made app's manifest and page, nothing else, and depends on nothing of the
 * app it came from: that app may change, move or go, and the listing stays
 * as it was published.
 *
 * Every statement about the table is here, and each one names a group: the
 * listing's own (`space_id = @spaceId`), or the groups of the person asking
 * (`LISTED`). Who sees a listing is decided by `LISTED` alone; who may use a
 * copy of one stays with VISIBLE (src/apps/installs.ts), since a copy is an
 * ordinary made app. A test reads this file and checks both.
 *
 * A listing goes when it is unpublished, and when its publisher leaves the
 * group or is removed from it, or the group is deleted: the database
 * cascades from space_members, and sets `made_apps.origin` of its copies to
 * NULL.
 */
import { randomBytes } from "node:crypto";
import { MAX_CENTER_LISTINGS } from "@hearth/shared";
import type { Db } from "../db/database";
import { templateHash } from "../made/catalog";
import { madeManifestSchema, type MadeManifest } from "../made/manifest";

/**
 * Who sees a listing: a member of the group it is published to. Nobody else
 * hears of it, the server's owner included; to them it is as absent as one
 * that never was.
 */
export const LISTED = "space_id IN (SELECT space_id FROM space_members WHERE user_id = @userId)";

const LISTING_ID_PREFIX = "p-";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function newListingId(): string {
  let id = LISTING_ID_PREFIX;
  for (const byte of randomBytes(10)) id += ALPHABET[byte % ALPHABET.length];
  return id;
}

/** A listing, without its page: what the center lists. */
export type Listing = {
  id: string;
  /** The group it is published to. */
  spaceId: string;
  /** The publisher, and their name as the group's members see it. */
  createdBy: string;
  publisherName: string;
  /** Where it was last published from, as it was then: the app may have moved or gone since. */
  sourceSpaceId: string;
  sourceAppId: string;
  manifest: MadeManifest;
  /** `templateHash` of its manifest and page: a copy whose own hash is this one is untouched. */
  hash: string;
  revision: number;
  note: string;
  createdAt: string;
  updatedAt: string;
};

/** A listing with its page: what a copy is made from. */
export type ListingWithPage = Listing & { html: string };

type ListingRow = Omit<Listing, "manifest"> & { manifest: string };

/** The columns of a listing but its page, from `published_apps p`. */
const COLUMNS = `id, space_id AS spaceId, created_by AS createdBy,
       (SELECT u.name FROM users u WHERE u.id = p.created_by) AS publisherName,
       source_space_id AS sourceSpaceId, source_app_id AS sourceAppId, manifest, hash, revision, note,
       created_at AS createdAt, updated_at AS updatedAt`;

/** A stored listing as the code sees it, or null when its manifest no longer reads. */
function fromRow<Row extends ListingRow>(row: Row): (Omit<Row, "manifest"> & { manifest: MadeManifest }) | null {
  // Checked when it was published; read again so that what the server hands on always fits.
  const manifest = madeManifestSchema.safeParse(JSON.parse(row.manifest));
  return manifest.success ? { ...row, manifest: manifest.data } : null;
}

/** What publishing writes: the snapshot, who published it, from where, and what changed. */
export type Snapshot = {
  /** The group, which the caller has checked the publisher is a member of. */
  spaceId: string;
  userId: string;
  sourceSpaceId: string;
  sourceAppId: string;
  manifest: MadeManifest;
  html: string;
  note: string;
  now: string;
};

/**
 * Publishes an app to a group for the first time: revision 1. The caller has
 * checked who may publish it and what it holds. Throws the database's
 * UNIQUE error when the app is published to that group already: publish it
 * again with `replaceListing`.
 */
export function insertListing(db: Db, snapshot: Snapshot): { id: string; revision: number } {
  const id = newListingId();
  db.prepare(
    `INSERT INTO published_apps
       (id, space_id, created_by, source_space_id, source_app_id, manifest, html, hash, revision, note, created_at, updated_at)
     VALUES (@id, @spaceId, @userId, @sourceSpaceId, @sourceAppId, @manifest, @html, @hash, 1, @note, @now, @now)`,
  ).run({ ...snapshot, id, manifest: JSON.stringify(snapshot.manifest), hash: templateHash(snapshot.manifest, snapshot.html) });
  return { id, revision: 1 };
}

/**
 * Publishes an app to a group again: the snapshot, the note and where it
 * came from are replaced, the revision goes up by one, and whoever
 * published it now becomes its publisher. Only the newest snapshot is
 * kept. Null when the group holds no listing of that ID.
 */
export function replaceListing(db: Db, snapshot: Snapshot & { id: string }): { id: string; revision: number } | null {
  const row = db
    .prepare(
      `UPDATE published_apps
          SET created_by = @userId, source_space_id = @sourceSpaceId, manifest = @manifest, html = @html, hash = @hash,
              revision = revision + 1, note = @note, updated_at = @now
        WHERE id = @id AND space_id = @spaceId AND source_app_id = @sourceAppId
        RETURNING revision`,
    )
    .get({ ...snapshot, manifest: JSON.stringify(snapshot.manifest), hash: templateHash(snapshot.manifest, snapshot.html) }) as
    | { revision: number }
    | undefined;
  return row ? { id: snapshot.id, revision: row.revision } : null;
}

/**
 * Unpublishes: the listing goes, at once. Its copies stay as they are; the
 * database sets their `origin` to NULL. False when the group holds no
 * listing of that ID.
 */
export function deleteListing(db: Db, listing: { id: string; spaceId: string }): boolean {
  return db.prepare("DELETE FROM published_apps WHERE id = @id AND space_id = @spaceId").run(listing).changes > 0;
}

/** The listings of every group the person is in, newest first, at most `limit`, without their pages. */
export function listListingsFor(db: Db, userId: string, limit = MAX_CENTER_LISTINGS): Listing[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM published_apps p WHERE ${LISTED} ORDER BY updated_at DESC, id LIMIT @limit`)
    .all({ userId, limit }) as ListingRow[];
  return rows.flatMap((row) => fromRow(row) ?? []);
}

/** One listing with its page, for a member of its group; null for everyone else, as for one that does not exist. */
export function findListingFor(db: Db, request: { userId: string; id: string }): ListingWithPage | null {
  const row = db.prepare(`SELECT ${COLUMNS}, html FROM published_apps p WHERE id = @id AND ${LISTED}`).get(request) as
    | (ListingRow & { html: string })
    | undefined;
  return row ? fromRow(row) : null;
}

/** The listing of an app in a group, by the app's ID wherever it lives now, or null: what publishing again replaces. */
export function listingIdOf(db: Db, request: { spaceId: string; sourceAppId: string }): string | null {
  const row = db
    .prepare("SELECT id FROM published_apps WHERE space_id = @spaceId AND source_app_id = @sourceAppId")
    .get(request) as { id: string } | undefined;
  return row?.id ?? null;
}

/** How many apps a person has published to a group, against MAX_LISTINGS_PER_GROUP. */
export function countListingsBy(db: Db, request: { spaceId: string; userId: string }): number {
  return (
    db.prepare("SELECT count(*) AS n FROM published_apps WHERE space_id = @spaceId AND created_by = @userId").get(request) as {
      n: number;
    }
  ).n;
}

/** Where an app is published, among the groups the person is in: what its publish dialog lists. */
export type AppListingRow = Pick<Listing, "id" | "spaceId" | "createdBy" | "revision" | "note" | "updatedAt">;

/** The listings of one app in the person's groups, oldest group first by when it was published there. */
export function listingsOfAppFor(db: Db, request: { userId: string; sourceAppId: string }): AppListingRow[] {
  return db
    .prepare(
      `SELECT id, space_id AS spaceId, created_by AS createdBy, revision, note, updated_at AS updatedAt
         FROM published_apps p
        WHERE source_app_id = @sourceAppId AND ${LISTED}
        ORDER BY created_at, id`,
    )
    .all(request) as AppListingRow[];
}

/**
 * The publishers' names of these listings, by listing, for those in the
 * person's groups alone: what the session shows beside a copy ("by Lin").
 * A listing outside them, or gone, is missing from the answer.
 */
export function publisherNamesFor(db: Db, request: { userId: string; ids: readonly string[] }): Map<string, string> {
  if (request.ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, (SELECT u.name FROM users u WHERE u.id = p.created_by) AS name
         FROM published_apps p
        WHERE id IN (SELECT value FROM json_each(@ids)) AND ${LISTED}`,
    )
    .all({ userId: request.userId, ids: JSON.stringify(request.ids) }) as { id: string; name: string }[];
  return new Map(rows.map((row) => [row.id, row.name]));
}
