/**
 * The SQL of the app center (docs/center.md): `published_apps` is named in
 * `center/published.ts` alone, every statement there names a group, and who
 * sees a listing is the one fragment `LISTED`. The first two tests read
 * source text, as the store's own test does (src/apps/store-boundary.test.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHECKLIST, family, JOURNAL, makeApp, NOW, PAGE } from "../apps/test-world";
import { templateHash } from "../made/catalog";
import { deleteListing, findListingFor, insertListing, LISTED, listListingsFor, replaceListing, type Snapshot } from "./published";

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = /\bpublished_apps\b/;
const ALLOWED = ["center/published.ts", "db/migrations.ts"];

function sourceFiles(folder = SOURCE): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [path.relative(SOURCE, file).split(path.sep).join("/")] : [];
  });
}

describe("SQL about published apps", () => {
  it("is in center/published.ts and nowhere else", () => {
    const files = sourceFiles();
    expect(files).toEqual(expect.arrayContaining(["made/apps.ts", "apps/installs.ts", ...ALLOWED]));
    const checked = files.filter((file) => !file.endsWith(".test.ts") && !ALLOWED.includes(file));
    expect(checked.filter((file) => TABLE.test(readFileSync(path.join(SOURCE, file), "utf8")))).toEqual([]);
  });

  it("names a group in every statement: the listing's own, or the person's", () => {
    const source = readFileSync(path.join(SOURCE, "center/published.ts"), "utf8");
    const statements = [...source.matchAll(/[`"]([^`"]*)[`"]/g)]
      .map((match) => match[1] ?? "")
      .filter((text) => TABLE.test(text) && /\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(text));
    expect(statements.length).toBeGreaterThanOrEqual(5);
    for (const statement of statements) {
      const scoped =
        statement.includes("${LISTED}") ||
        /\bspace_id = @spaceId\b/.test(statement) ||
        (/^\s*INSERT INTO published_apps\b/.test(statement) && /\(@id, @spaceId,/.test(statement));
      expect(scoped, statement).toBe(true);
    }
    // And who sees a listing is membership of its group, and nothing else.
    expect(LISTED).toBe("space_id IN (SELECT space_id FROM space_members WHERE user_id = @userId)");
  });
});

describe("published apps", () => {
  function world() {
    const w = family();
    makeApp(w.db, w.linsSpace, "m-ledger0001", w.lin.id, { manifest: CHECKLIST });
    const snapshot: Snapshot = {
      spaceId: w.family,
      userId: w.lin.id,
      sourceSpaceId: w.linsSpace,
      sourceAppId: "m-ledger0001",
      manifest: CHECKLIST,
      html: PAGE,
      note: "",
      now: NOW,
    };
    return { ...w, snapshot };
  }

  it("are listed to the members of their group alone, newest first", () => {
    const w = world();
    const first = insertListing(w.db, w.snapshot);
    expect(first).toEqual({ id: expect.stringMatching(/^p-[a-z0-9]{10}$/), revision: 1 });
    const second = insertListing(w.db, { ...w.snapshot, sourceAppId: "m-journal001", manifest: JOURNAL, now: "2026-01-05T00:00:00.000Z" });

    for (const member of [w.sam, w.lin, w.kim]) {
      expect(listListingsFor(w.db, member.id).map((listing) => listing.id)).toEqual([second.id, first.id]);
    }
    expect(listListingsFor(w.db, w.lin.id, 1).map((listing) => listing.id)).toEqual([second.id]);
    const [, listed] = listListingsFor(w.db, w.sam.id);
    expect(listed).toEqual({
      id: first.id,
      spaceId: w.family,
      createdBy: w.lin.id,
      publisherName: expect.any(String),
      sourceSpaceId: w.linsSpace,
      sourceAppId: "m-ledger0001",
      manifest: CHECKLIST,
      hash: templateHash(CHECKLIST, PAGE),
      revision: 1,
      note: "",
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(findListingFor(w.db, { userId: w.kim.id, id: first.id })).toEqual({ ...listed, html: PAGE });

    // Noa is in no group with Lin: nothing is listed, and the listing is as absent as one that never was.
    expect(listListingsFor(w.db, w.noa.id)).toEqual([]);
    expect(findListingFor(w.db, { userId: w.noa.id, id: first.id })).toBeNull();
    expect(findListingFor(w.db, { userId: w.sam.id, id: "p-nothing000" })).toBeNull();
  });

  it("hold one listing of an app per group, published again with a new revision", () => {
    const w = world();
    const { id } = insertListing(w.db, w.snapshot);
    expect(() => insertListing(w.db, w.snapshot)).toThrow(/UNIQUE/);

    // Sam, an owner of the family, publishes it again: the snapshot is replaced and he is its publisher now.
    const again = { ...w.snapshot, id, userId: w.sam.id, manifest: JOURNAL, note: "Bigger buttons", now: "2026-01-06T00:00:00.000Z" };
    expect(replaceListing(w.db, again)).toEqual({ id, revision: 2 });
    expect(findListingFor(w.db, { userId: w.lin.id, id })).toMatchObject({
      createdBy: w.sam.id,
      manifest: JOURNAL,
      hash: templateHash(JOURNAL, PAGE),
      revision: 2,
      note: "Bigger buttons",
      createdAt: NOW,
      updatedAt: "2026-01-06T00:00:00.000Z",
    });
    // Only in its own group, and only for the app it is a listing of.
    expect(replaceListing(w.db, { ...again, spaceId: w.linsSpace })).toBeNull();
    expect(replaceListing(w.db, { ...again, sourceAppId: "m-journal001" })).toBeNull();
    expect(findListingFor(w.db, { userId: w.lin.id, id })?.revision).toBe(2);
  });

  it("are unpublished in their own group only", () => {
    const w = world();
    const { id } = insertListing(w.db, w.snapshot);
    expect(deleteListing(w.db, { id, spaceId: w.linsSpace })).toBe(false);
    expect(findListingFor(w.db, { userId: w.lin.id, id })).not.toBeNull();
    expect(deleteListing(w.db, { id, spaceId: w.family })).toBe(true);
    expect(findListingFor(w.db, { userId: w.lin.id, id })).toBeNull();
  });

  it("go when their publisher leaves the group, and copies made of them are left as they are", () => {
    const w = world();
    const { id } = insertListing(w.db, w.snapshot);
    makeApp(w.db, w.samsSpace, "m-copy000001", w.sam.id, { manifest: CHECKLIST });
    w.db
      .prepare("UPDATE made_apps SET origin = ?, origin_hash = ?, origin_revision = 1 WHERE app_id = 'm-copy000001'")
      .run(id, templateHash(CHECKLIST, PAGE));
    // A listing names a member of its group as its publisher, or none.
    expect(() => insertListing(w.db, { ...w.snapshot, sourceAppId: "m-journal001", userId: w.noa.id })).toThrow(/FOREIGN KEY/);

    w.db.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?").run(w.family, w.lin.id);
    expect(listListingsFor(w.db, w.sam.id)).toEqual([]);
    expect(w.db.prepare("SELECT origin, origin_hash AS hash, origin_revision AS revision FROM made_apps WHERE app_id = 'm-copy000001'").get()).toEqual({
      origin: null,
      hash: templateHash(CHECKLIST, PAGE),
      revision: 1,
    });
  });
});
