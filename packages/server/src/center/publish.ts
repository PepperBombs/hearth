/**
 * Publishing an app to a group, and unpublishing it (docs/center.md,
 * "Routes" and "Privacy and safety"): who may, what would leave, and what
 * refuses it. What leaves is the app's manifest and page, nothing else; the
 * table is center/published.ts's.
 *
 * The problems are codes (`PUBLISH_PROBLEM_CODES`), which the publish dialog
 * words in the person's language from GET .../publish. A refused POST gives
 * the same problems as one English message, since a Refusal's message is
 * English.
 */
import {
  MAX_LISTINGS_PER_GROUP,
  type AppListing,
  type PublishPlace,
  type PublishProblem,
  type PublishReview,
  type PublishResult,
} from "@hearth/shared";
import type { Registry } from "../apps/registry";
import type { Db } from "../db/database";
import { emailsAround, listSpacesForUser, membershipOf } from "../db/people";
import { notFound, Refusal } from "../http/errors";
import { publishableApp, type PublishSource } from "../made/apps";
import { checkMadeManifest, inBoth, madeHtmlSchema } from "../made/manifest";
import {
  countListingsBy,
  deleteListing,
  findListingFor,
  insertListing,
  listingOfApp,
  listingsOfAppFor,
  replaceListing,
} from "./published";

type AppRequest = { userId: string; spaceId: string; appId: string };

/** How many places holding an email address one review names at most: enough to find them, never a page of them. */
export const MOST_EMAIL_PLACES = 10;

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The places of the manifest and page that hold one of these addresses, in
 * any case, as a whole address: "sam@example.com" is not found in
 * "jimsam@example.com" or "sam@example.com.au".
 */
export function emailPlaces(app: Pick<PublishSource, "manifest" | "html">, emails: readonly string[]): PublishPlace[] {
  if (emails.length === 0) return [];
  const address = new RegExp(`(?<![\\p{L}\\p{N}._%+-])(?:${emails.map(escaped).join("|")})(?![\\p{L}\\p{N}-]|\\.[\\p{L}\\p{N}])`, "iu");
  const { manifest } = app;
  const parts: [PublishPlace["part"], string][] = [
    ["name", Object.values(inBoth(manifest.name)).join("\n")],
    ["description", Object.values(inBoth(manifest.description)).join("\n")],
    ["instructions", manifest.instructions],
    ["collections", JSON.stringify(manifest.collections)],
    ["settings", JSON.stringify(manifest.settings ?? {})],
  ];
  const places: PublishPlace[] = parts.filter(([, text]) => address.test(text)).map(([part]) => ({ part }));
  const lines = app.html.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length && places.length < MOST_EMAIL_PLACES; index++) {
    if (address.test(lines[index]!)) places.push({ part: "page", line: index + 1 });
  }
  return places.slice(0, MOST_EMAIL_PLACES);
}

/** What refuses the app wherever it goes: everything but "too_many", which depends on the group. */
function problemsOf(db: Db, userId: string, app: PublishSource): PublishProblem[] {
  const problems: PublishProblem[] = [];
  const page = madeHtmlSchema.safeParse(app.html);
  const invalid = checkMadeManifest(app.manifest) ?? (page.success ? null : (page.error.issues[0]?.message ?? "The page is not valid."));
  if (invalid !== null) problems.push({ code: "invalid", detail: invalid });
  if ((app.manifest.network ?? []).length > 0) problems.push({ code: "network" });
  if (app.untouchedCopy) problems.push({ code: "unchanged_copy" });
  for (const where of emailPlaces(app, emailsAround(db, userId))) problems.push({ code: "email", where });
  return problems;
}

/**
 * Whether the person has as many apps published to the group as they may,
 * and this one is not among them. A listing of this app that someone else
 * published (another owner of a group's app) is not among them: publishing
 * it again makes the person its publisher, one more of theirs.
 */
function tooMany(db: Db, request: { userId: string; spaceId: string; appId: string }): boolean {
  const listing = listingOfApp(db, { spaceId: request.spaceId, sourceAppId: request.appId });
  return (
    listing?.createdBy !== request.userId &&
    countListingsBy(db, { spaceId: request.spaceId, userId: request.userId }) >= MAX_LISTINGS_PER_GROUP
  );
}

/**
 * GET .../publish: what would leave, where it may go, where it is published
 * among the person's groups, and every problem that would refuse it.
 */
export function reviewPublish(db: Db, registry: Registry, request: AppRequest): PublishReview {
  return db.transaction((): PublishReview => {
    const app = publishableApp(db, registry, request);
    const spaces = listSpacesForUser(db, request.userId);
    const groups = spaces.filter((space) => space.kind === "group");
    const owns = new Set(groups.filter((space) => space.role === "owner").map((space) => space.id));
    const listings: AppListing[] = listingsOfAppFor(db, { userId: request.userId, sourceAppId: request.appId }).map((listing) => ({
      id: listing.id,
      spaceId: listing.spaceId,
      revision: listing.revision,
      note: listing.note,
      updatedAt: listing.updatedAt,
      canUnpublish: listing.createdBy === request.userId || owns.has(listing.spaceId),
    }));
    const problems = problemsOf(db, request.userId, app);
    for (const group of groups) {
      if (tooMany(db, { ...request, spaceId: group.id })) problems.push({ code: "too_many", spaceId: group.id });
    }
    const { manifest } = app;
    return {
      app: {
        name: inBoth(manifest.name),
        description: inBoth(manifest.description),
        icon: manifest.icon,
        color: manifest.color,
        collections: Object.entries(manifest.collections).map(([name, collection]) => ({ name, fields: Object.keys(collection.fields) })),
        settings: manifest.settings ?? {},
        instructions: manifest.instructions,
        pageBytes: Buffer.byteLength(app.html, "utf8"),
      },
      groups: groups.map((group) => ({ id: group.id, name: group.name })),
      listings,
      problems,
    };
  })();
}

const PARTS: Record<PublishPlace["part"], string> = {
  name: "the name",
  description: "the description",
  instructions: "the instructions",
  collections: "the collections",
  settings: "the settings",
  page: "the page",
};

/** A problem in English, for the message of a refused publish. Where an address is, never whose. */
function inEnglish(problem: PublishProblem): string {
  switch (problem.code) {
    case "invalid":
      return `It is not valid: ${problem.detail ?? "the manifest or the page does not pass the checks"}.`;
    case "network":
      return "It names hosts, and a published app names none.";
    case "unchanged_copy":
      return "It is a copy nobody changed: someone else's app as they shipped or shared it.";
    case "email": {
      const where = problem.where ? PARTS[problem.where.part] + (problem.where.line ? `, line ${problem.where.line}` : "") : "it";
      return `The email address of you or of someone you share a space with is in ${where}.`;
    }
    case "too_many":
      return `You have ${MAX_LISTINGS_PER_GROUP} apps published to this group already: unpublish one first.`;
  }
}

/**
 * POST .../publish: publishes the app to a group the person is in, or
 * publishes it there again, which replaces the snapshot, adds 1 to the
 * revision and makes the person its publisher. `created` is false for
 * publishing again. The check and the write are one transaction.
 *
 * Throws a Refusal: 404 when the person cannot see the app or is not in the
 * group (or it does not exist); 403 when they may not publish the app; 400
 * for a personal space and for any problem but "too_many", which is 409.
 */
export function publishApp(
  db: Db,
  registry: Registry,
  request: AppRequest & { to: string; note?: string | undefined },
): PublishResult & { created: boolean } {
  return db
    .transaction(() => {
      const app = publishableApp(db, registry, request);
      const target = membershipOf(db, request.userId, request.to);
      if (!target) throw notFound();
      if (target.kind !== "group") throw new Refusal(400, "invalid_request", "An app is published to a group, not to a personal space.");
      const problems = problemsOf(db, request.userId, app);
      if (problems.length > 0) {
        throw new Refusal(400, "invalid_request", `This app cannot be published. ${problems.map(inEnglish).join(" ")}`);
      }
      if (tooMany(db, { ...request, spaceId: request.to })) {
        throw new Refusal(409, "conflict", inEnglish({ code: "too_many", spaceId: request.to }));
      }
      const snapshot = {
        spaceId: request.to,
        userId: request.userId,
        sourceSpaceId: request.spaceId,
        sourceAppId: request.appId,
        manifest: app.manifest,
        html: app.html,
        note: request.note ?? "",
        now: new Date().toISOString(),
      };
      const existing = listingOfApp(db, { spaceId: request.to, sourceAppId: request.appId });
      if (existing === null) return { ...insertListing(db, snapshot), created: true };
      const replaced = replaceListing(db, { ...snapshot, id: existing.id });
      // Found above, in this same transaction.
      if (!replaced) throw new Error("A listing found while publishing again was not there to replace.");
      return { ...replaced, created: false };
    })
    .immediate();
}

/**
 * DELETE /api/center/:id: unpublishes, for its publisher or an owner of its
 * group. Its copies stay as they are. Throws 404 for a listing outside the
 * person's groups, as for one that does not exist, and 403 for a member of
 * the group who neither published it nor owns the group.
 */
export function unpublishApp(db: Db, request: { userId: string; id: string }): void {
  db.transaction(() => {
    const listing = findListingFor(db, request);
    if (!listing) throw notFound();
    if (listing.createdBy !== request.userId && membershipOf(db, request.userId, listing.spaceId)?.role !== "owner") {
      throw new Refusal(403, "forbidden", "Unpublishing an app is for whoever published it and the group's owners.");
    }
    deleteListing(db, listing);
  }).immediate();
}
