/**
 * The app center through its routes (docs/center.md, "Tests"): who may
 * publish an app, what refuses it, publishing again, unpublishing, and
 * listings going with their publisher's membership; who sees a published
 * app, adding a copy, moving one, what stays independent of what, and that
 * nothing but code leaves. Sample people of
 * test-world: Sam owns the server and the group "family", Lin is a plain
 * member, Kim a member who may add apps, Noa is in no group with them.
 */
import { MAX_LISTINGS_PER_GROUP, type AppSummary, type Center, type PublishReview, type Session } from "@hearth/shared";
import { describe, expect, it } from "vitest";
import { CHECKLIST, family, grant, KIM, LIN, makeApp, NOA, NOW, PAGE, SAM } from "../apps/test-world";
import { changeMadeApp, madeAppsRegistry } from "../made/apps";
import { templateHash } from "../made/catalog";
import { madeManifestSchema } from "../made/manifest";
import { as, testApp } from "../testing";
import { findListingFor, insertListing, listListingsFor } from "./published";

const LEDGER = "m-ledger0001";

function world() {
  const people = family();
  const { app, errors } = testApp({ db: people.db });
  makeApp(people.db, people.linsSpace, LEDGER, people.lin.id);
  const call = (email: string, path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: as(email, init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const publishPath = (spaceId: string, appId: string) => `/api/spaces/${spaceId}/apps/${appId}/publish`;
  const publish = (email: string, spaceId: string, appId: string, body: unknown = { to: "family" }) =>
    call(email, publishPath(spaceId, appId), { method: "POST", body });
  const review = async (email: string, spaceId: string, appId: string) => {
    const answer = await call(email, publishPath(spaceId, appId));
    expect(answer.status).toBe(200);
    return (await answer.json()) as PublishReview;
  };
  /** Lin publishes Ledger to the family, and the listing's ID comes back. */
  const published = async () => {
    const answer = await publish(LIN, people.linsSpace, LEDGER);
    expect(answer.status).toBe(201);
    return ((await answer.json()) as { id: string }).id;
  };
  const addCopy = (email: string, spaceId: string, id: string, body: unknown = {}) =>
    call(email, `/api/spaces/${spaceId}/center/${id}`, { method: "POST", body });
  const center = async (email: string) => {
    const answer = await call(email, "/api/center");
    expect(answer.status).toBe(200);
    return (await answer.json()) as Center;
  };
  const appsOf = async (email: string) => ((await (await call(email, "/api/session")).json()) as Session).apps;
  return { ...people, call, publish, review, errors, published, addCopy, center, appsOf };
}

/** A copy as the database holds it. */
function stored(db: ReturnType<typeof family>["db"], appId: string) {
  return db
    .prepare(
      `SELECT m.space_id AS spaceId, m.version, m.html, m.template, m.template_hash AS templateHash, m.origin,
              m.origin_hash AS originHash, m.origin_revision AS originRevision, a.member_access AS memberAccess,
              (SELECT note FROM made_app_versions v WHERE v.app_id = m.app_id AND v.version = 1) AS firstNote
         FROM made_apps m JOIN space_apps a ON a.space_id = m.space_id AND a.app_id = m.app_id
        WHERE m.app_id = ?`,
    )
    .get(appId) as Record<string, unknown> | undefined;
}

/** A group Sam owns and Noa is in, which Lin and Kim are not. */
function work(db: ReturnType<typeof family>["db"], sam: string, noa: string): void {
  db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('work', 'group', 'Work', ?, ?)").run(sam, NOW);
  const join = db.prepare("INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES ('work', ?, ?, 0, ?)");
  join.run(sam, "owner", NOW);
  join.run(noa, "member", NOW);
}

/** Sets a made app's page straight in the database, as a change in the chat would have. */
function setPage(db: ReturnType<typeof family>["db"], appId: string, html: string): void {
  db.prepare("UPDATE made_apps SET html = ? WHERE app_id = ?").run(html, appId);
}

describe("publishing an app", () => {
  it("shows exactly what would leave, and publishes it to a group of the person's", async () => {
    const w = world();
    const before = await w.review(LIN, w.linsSpace, LEDGER);
    expect(before).toEqual({
      app: {
        name: { en: "Checklist", zh: "清单" },
        description: CHECKLIST.description,
        icon: "list-checks",
        color: "teal",
        collections: [{ name: "items", fields: ["name", "section", "done"] }],
        settings: CHECKLIST.settings,
        instructions: "",
        pageBytes: Buffer.byteLength(PAGE),
      },
      groups: [{ id: "family", name: "Family" }],
      listings: [],
      problems: [],
    });

    const published = await w.publish(LIN, w.linsSpace, LEDGER, { to: "family", note: "  First go  " });
    expect(published.status).toBe(201);
    const { id, revision } = (await published.json()) as { id: string; revision: number };
    expect(revision).toBe(1);
    expect(findListingFor(w.db, { userId: w.sam.id, id })).toMatchObject({
      spaceId: "family",
      createdBy: w.lin.id,
      sourceSpaceId: w.linsSpace,
      sourceAppId: LEDGER,
      manifest: CHECKLIST,
      html: PAGE,
      note: "First go",
    });
    expect((await w.review(LIN, w.linsSpace, LEDGER)).listings).toEqual([
      { id, spaceId: "family", revision: 1, note: "First go", updatedAt: expect.any(String), canUnpublish: true },
    ]);
    expect(w.errors).toEqual([]);
  });

  it("is for an owner of the app's space, to a group they are in", async () => {
    const w = world();
    // A group's app: Sam owns the group, Kim may add apps and has edit, Lin may only view it.
    makeApp(w.db, "family", "m-shared0001", w.sam.id, { memberAccess: "view" });
    grant(w.db, "family", "m-shared0001", w.kim.id, "edit", w.sam.id);
    // Lin has edit but may not add apps; Kim may add apps and has edit, but owns nothing here.
    makeApp(w.db, "family", "m-shared0002", w.sam.id, { memberAccess: "edit" });
    // A group Noa owns, which Lin is not in.
    w.db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('work', 'group', 'Work', ?, ?)").run(w.noa.id, NOW);
    w.db.prepare("INSERT INTO space_members (space_id, user_id, role, can_add_apps, created_at) VALUES ('work', ?, 'owner', 0, ?)").run(w.noa.id, NOW);

    expect((await w.publish(LIN, "family", "m-shared0001")).status).toBe(403); // view only
    expect((await w.publish(LIN, "family", "m-shared0002")).status).toBe(403); // edit, but may not add apps
    expect((await w.publish(KIM, "family", "m-shared0001")).status).toBe(403); // may change it, owns no group
    expect((await w.call(KIM, `/api/spaces/family/apps/m-shared0001/publish`)).status).toBe(403);
    expect((await w.publish(NOA, "family", "m-shared0001")).status).toBe(404); // cannot see it
    expect((await w.publish(SAM, w.linsSpace, LEDGER)).status).toBe(404); // someone else's personal app
    expect((await w.publish(LIN, w.linsSpace, LEDGER, { to: w.linsSpace })).status).toBe(400); // not a group
    expect((await w.publish(LIN, w.linsSpace, LEDGER, { to: w.samsSpace })).status).toBe(404); // not hers
    expect((await w.publish(LIN, w.linsSpace, LEDGER, { to: "work" })).status).toBe(404); // not in it
    expect((await w.publish(LIN, w.linsSpace, LEDGER, { to: "nowhere" })).status).toBe(404);
    expect(listListingsFor(w.db, w.sam.id)).toEqual([]);

    // The group's owner may publish the group's app.
    expect((await w.publish(SAM, "family", "m-shared0001")).status).toBe(201);
  });

  it("again replaces the snapshot, adds 1 to the revision, and reaches nothing else", async () => {
    const w = world();
    const { id } = (await (await w.publish(LIN, w.linsSpace, LEDGER)).json()) as { id: string };
    // A change to the source does not reach the listing until it is published again.
    setPage(w.db, LEDGER, "<!doctype html><p>Second</p>");
    expect(findListingFor(w.db, { userId: w.lin.id, id })?.html).toBe(PAGE);

    const again = await w.publish(LIN, w.linsSpace, LEDGER, { to: "family", note: "A new page" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, revision: 2 });
    expect(findListingFor(w.db, { userId: w.lin.id, id })).toMatchObject({ html: "<!doctype html><p>Second</p>", revision: 2, note: "A new page" });
    expect(listListingsFor(w.db, w.lin.id)).toHaveLength(1);
  });
});

describe("what refuses publishing", () => {
  it("is an app that names hosts", async () => {
    const w = world();
    const manifest = madeManifestSchema.parse({ ...CHECKLIST, network: ["api.example.com"] });
    makeApp(w.db, w.linsSpace, "m-hosts00001", w.lin.id, { manifest });
    expect((await w.review(LIN, w.linsSpace, "m-hosts00001")).problems).toEqual([{ code: "network" }]);
    const refused = await w.publish(LIN, w.linsSpace, "m-hosts00001");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/names hosts/);
  });

  it("is a copy nobody changed, of a built-in app or of a published one", async () => {
    const w = world();
    // A built-in copy Hearth still keeps up to date.
    makeApp(w.db, w.linsSpace, "m-builtin001", w.lin.id);
    w.db.prepare("UPDATE made_apps SET template = 'grocery', template_hash = 'abc' WHERE app_id = 'm-builtin001'").run();
    expect((await w.review(LIN, w.linsSpace, "m-builtin001")).problems).toEqual([{ code: "unchanged_copy" }]);
    expect((await w.publish(LIN, w.linsSpace, "m-builtin001")).status).toBe(400);

    // A copy of Sam's published app, as it was shared.
    const listing = insertListing(w.db, {
      spaceId: "family",
      userId: w.sam.id,
      sourceSpaceId: w.samsSpace,
      sourceAppId: "m-samsapp001",
      manifest: CHECKLIST,
      html: PAGE,
      note: "",
      now: NOW,
    });
    makeApp(w.db, w.linsSpace, "m-copy000001", w.lin.id);
    w.db
      .prepare("UPDATE made_apps SET origin = ?, origin_hash = ?, origin_revision = 1 WHERE app_id = 'm-copy000001'")
      .run(listing.id, templateHash(CHECKLIST, PAGE));
    expect((await w.review(LIN, w.linsSpace, "m-copy000001")).problems).toEqual([{ code: "unchanged_copy" }]);
    expect((await w.publish(LIN, w.linsSpace, "m-copy000001")).status).toBe(400);

    // Changed by one character, it is hers.
    setPage(w.db, "m-copy000001", `${PAGE} `);
    expect((await w.review(LIN, w.linsSpace, "m-copy000001")).problems).toEqual([]);
    expect((await w.publish(LIN, w.linsSpace, "m-copy000001")).status).toBe(201);
  });

  it("is the email address of the publisher or of a member of a space they own, named by where and not whose", async () => {
    const w = world();
    // Sam owns the family, so its members' addresses are his to see: Lin's is looked for in his app.
    const manifest = madeManifestSchema.parse({ ...CHECKLIST, instructions: "Ask LIN@Example.com before deleting." });
    makeApp(w.db, w.samsSpace, "m-email00001", w.sam.id, {
      manifest,
      html: "<!doctype html>\n<p>Hello</p>\n<p>Write to owner@example.com.</p>\n<p>not jimowner@example.com, nor owner@example.com.au</p>",
    });
    expect((await w.review(SAM, w.samsSpace, "m-email00001")).problems).toEqual([
      { code: "email", where: { part: "instructions" } },
      { code: "email", where: { part: "page", line: 3 } },
    ]);
    const refused = await w.publish(SAM, w.samsSpace, "m-email00001");
    expect(refused.status).toBe(400);
    const message = await refused.text();
    expect(message).toMatch(/the instructions.*the page, line 3/);
    expect(message).not.toMatch(/example\.com/i);

    // Noa shares no space with Sam: her address is not looked for, so its presence says nothing about her.
    setPage(w.db, "m-email00001", "<!doctype html><p>noa@example.com</p>");
    w.db.prepare("UPDATE made_apps SET manifest = ? WHERE app_id = 'm-email00001'").run(JSON.stringify(CHECKLIST));
    expect((await w.review(SAM, w.samsSpace, "m-email00001")).problems).toEqual([]);
    expect((await w.publish(SAM, w.samsSpace, "m-email00001")).status).toBe(201);
  });

  it("never tells a plain member whether an address is a fellow member's, which Hearth does not show them", async () => {
    const w = world();
    // Lin is a plain member of the family, and owns only her personal space: her own address is looked for,
    // Sam's and Kim's are not, so guessing them line by line learns nothing.
    makeApp(w.db, w.linsSpace, "m-email00002", w.lin.id, {
      html: "<!doctype html>\n<p>lin@example.com</p>\n<p>owner@example.com</p>\n<p>kim@example.com</p>",
    });
    expect((await w.review(LIN, w.linsSpace, "m-email00002")).problems).toEqual([{ code: "email", where: { part: "page", line: 2 } }]);
    const refused = await w.publish(LIN, w.linsSpace, "m-email00002");
    expect(refused.status).toBe(400);
    const message = await refused.text();
    expect(message).toMatch(/the page, line 2\./);
    expect(message).not.toMatch(/line [34]/);

    // Once she owns the family, its members' addresses are shown to her there, and looked for.
    w.db.prepare("UPDATE space_members SET role = 'owner' WHERE space_id = 'family' AND user_id = ?").run(w.lin.id);
    expect((await w.review(LIN, w.linsSpace, "m-email00002")).problems).toEqual([
      { code: "email", where: { part: "page", line: 2 } },
      { code: "email", where: { part: "page", line: 3 } },
      { code: "email", where: { part: "page", line: 4 } },
    ]);
  });

  it(`is a ${MAX_LISTINGS_PER_GROUP + 1}st app of one person in one group, while publishing again still works`, async () => {
    const w = world();
    for (let n = 0; n < MAX_LISTINGS_PER_GROUP - 1; n++) {
      insertListing(w.db, {
        spaceId: "family",
        userId: w.lin.id,
        sourceSpaceId: w.linsSpace,
        sourceAppId: `m-other${String(n).padStart(5, "0")}`,
        manifest: CHECKLIST,
        html: PAGE,
        note: "",
        now: NOW,
      });
    }
    expect((await w.publish(LIN, w.linsSpace, LEDGER)).status).toBe(201); // the 50th
    expect((await w.publish(LIN, w.linsSpace, LEDGER)).status).toBe(200); // again

    makeApp(w.db, w.linsSpace, "m-ledger0002", w.lin.id);
    expect((await w.review(LIN, w.linsSpace, "m-ledger0002")).problems).toEqual([{ code: "too_many", spaceId: "family" }]);
    const refused = await w.publish(LIN, w.linsSpace, "m-ledger0002");
    expect(refused.status).toBe(409);
    // Someone else's count is their own.
    makeApp(w.db, w.samsSpace, "m-samsapp001", w.sam.id);
    expect((await w.publish(SAM, w.samsSpace, "m-samsapp001")).status).toBe(201);
  });

  it(`counts publishing again someone else's listing as one more of the person's, past ${MAX_LISTINGS_PER_GROUP} refused`, async () => {
    const w = world();
    // The family's app, which Sam publishes; Lin, made an owner of the family too, has 50 apps there already.
    makeApp(w.db, w.family, "m-family0001", w.sam.id);
    expect((await w.publish(SAM, w.family, "m-family0001")).status).toBe(201);
    w.db.prepare("UPDATE space_members SET role = 'owner' WHERE space_id = 'family' AND user_id = ?").run(w.lin.id);
    for (let n = 0; n < MAX_LISTINGS_PER_GROUP; n++) {
      insertListing(w.db, {
        spaceId: "family",
        userId: w.lin.id,
        sourceSpaceId: w.linsSpace,
        sourceAppId: `m-other${String(n).padStart(5, "0")}`,
        manifest: CHECKLIST,
        html: PAGE,
        note: "",
        now: NOW,
      });
    }
    // Publishing it again would make her its publisher, her 51st.
    expect((await w.review(LIN, w.family, "m-family0001")).problems).toEqual([{ code: "too_many", spaceId: "family" }]);
    expect((await w.publish(LIN, w.family, "m-family0001")).status).toBe(409);
    expect(listListingsFor(w.db, w.lin.id).filter((listing) => listing.createdBy === w.lin.id)).toHaveLength(MAX_LISTINGS_PER_GROUP);
    // Sam, its publisher, still publishes it again.
    expect((await w.review(SAM, w.family, "m-family0001")).problems).toEqual([]);
    expect((await w.publish(SAM, w.family, "m-family0001")).status).toBe(200);
  });
});

describe("unpublishing", () => {
  it("is for the publisher and the group's owners; a member or an outsider cannot, and learns nothing", async () => {
    const w = world();
    const first = (await (await w.publish(LIN, w.linsSpace, LEDGER)).json()) as { id: string };
    expect((await w.call(KIM, `/api/center/${first.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await w.call(NOA, `/api/center/${first.id}`, { method: "DELETE" })).status).toBe(404);
    expect((await w.call(NOA, `/api/center/p-nothing000`, { method: "DELETE" })).status).toBe(404);
    expect((await w.call(LIN, `/api/center/${first.id}`, { method: "DELETE" })).status).toBe(204);
    expect(listListingsFor(w.db, w.lin.id)).toEqual([]);
    expect((await w.call(LIN, `/api/center/${first.id}`, { method: "DELETE" })).status).toBe(404);

    const second = (await (await w.publish(LIN, w.linsSpace, LEDGER)).json()) as { id: string };
    expect(second.id).not.toBe(first.id);
    // Sam owns the group: he may unpublish Lin's app there, and the dialog says so.
    const samsView = await w.call(SAM, `/api/spaces/${w.linsSpace}/apps/${LEDGER}/publish`);
    expect(samsView.status).toBe(404); // not his app to review
    expect((await w.call(SAM, `/api/center/${second.id}`, { method: "DELETE" })).status).toBe(204);
    expect(listListingsFor(w.db, w.lin.id)).toEqual([]);
  });

  it("happens when the publisher leaves the group, is removed from it, or the group is deleted", async () => {
    const w = world();
    await w.publish(LIN, w.linsSpace, LEDGER);
    expect((await w.call(LIN, `/api/spaces/family/members/${w.lin.id}`, { method: "DELETE" })).status).toBe(204);
    expect(listListingsFor(w.db, w.sam.id)).toEqual([]);

    makeApp(w.db, w.kimsSpace, "m-kimsapp001", w.kim.id);
    w.db.prepare("UPDATE space_members SET role = 'owner' WHERE space_id = 'family' AND user_id = ?").run(w.kim.id);
    expect((await w.publish(KIM, w.kimsSpace, "m-kimsapp001")).status).toBe(201);
    expect((await w.call(SAM, `/api/spaces/family/members/${w.kim.id}`, { method: "DELETE" })).status).toBe(204);
    expect(listListingsFor(w.db, w.sam.id)).toEqual([]);

    makeApp(w.db, w.samsSpace, "m-samsapp001", w.sam.id);
    expect((await w.publish(SAM, w.samsSpace, "m-samsapp001")).status).toBe(201);
    const deleted = await w.call(SAM, `/api/spaces/family/members/${w.sam.id}`, { method: "DELETE", body: { confirm: "Family" } });
    expect(deleted.status).toBe(204);
    expect(w.db.prepare("SELECT count(*) AS n FROM spaces WHERE id = 'family'").get()).toEqual({ n: 0 });
    expect(listListingsFor(w.db, w.sam.id)).toEqual([]);
    expect(w.errors).toEqual([]);
  });
});

describe("the app center", () => {
  it("lists a published app to the members of its group alone, and to nobody else exists", async () => {
    const w = world();
    const id = await w.published();
    const listing = {
      id,
      spaceId: "family",
      name: { en: "Checklist", zh: "清单" },
      description: CHECKLIST.description,
      icon: "list-checks",
      color: "teal",
      collections: [{ name: "items", fields: ["name", "section", "done"] }],
      publishedBy: { id: w.lin.id, name: "lin" },
      revision: 1,
      note: "",
      updatedAt: expect.any(String),
    };
    expect(await w.center(LIN)).toEqual({ listings: [{ ...listing, mine: true, canUnpublish: true }] });
    expect(await w.center(SAM)).toEqual({ listings: [{ ...listing, mine: false, canUnpublish: true }] }); // owns the group
    expect(await w.center(KIM)).toEqual({ listings: [{ ...listing, mine: false, canUnpublish: false }] });

    // Noa is in no group with them, only in another: nothing is listed, and every route answers as for nothing.
    work(w.db, w.sam.id, w.noa.id);
    expect(await w.center(NOA)).toEqual({ listings: [] });
    const noasSpace = (w.db.prepare("SELECT id FROM spaces WHERE created_by = ? AND kind = 'personal'").get(w.noa.id) as { id: string }).id;
    expect((await w.addCopy(NOA, noasSpace, id)).status).toBe(404);
    expect((await w.addCopy(NOA, "family", id)).status).toBe(404);
    expect((await w.call(NOA, `/api/center/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await w.addCopy(SAM, w.samsSpace, "p-nothing000")).status).toBe(404);
    expect(w.errors).toEqual([]);
  });
});

describe("adding a copy", () => {
  it("makes a made app of the space's own from the snapshot, with its first version noted", async () => {
    const w = world();
    const id = await w.published();
    const added = await w.addCopy(SAM, w.samsSpace, id);
    expect(added.status).toBe(201);
    const { appId, restored } = (await added.json()) as { appId: string; restored: boolean };
    expect(restored).toBe(false);
    expect(appId).toMatch(/^m-[a-z0-9]{10}$/);
    expect(appId).not.toBe(LEDGER);
    expect(stored(w.db, appId)).toEqual({
      spaceId: w.samsSpace,
      version: 1,
      html: PAGE,
      template: null,
      templateHash: null,
      origin: id,
      originHash: templateHash(CHECKLIST, PAGE),
      originRevision: 1,
      memberAccess: "none",
      firstNote: "Copy of “Checklist” (revision 1)",
    });
    // No entries of its own yet, and its settings at their defaults.
    expect(await (await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}/rows/items`)).json()).toEqual({ rows: [] });
    // In the session, a copy of Lin's, whom Sam shares the family with.
    const copy = (await w.appsOf(SAM)).find((app) => app.id === appId);
    expect(copy).toMatchObject({ spaceId: w.samsSpace, made: true, version: 1, source: { listingId: id, by: "lin", untouched: true } });
    expect(copy?.source).not.toHaveProperty("mine");
    expect(copy).not.toHaveProperty("template");
  });

  it("goes only to the listing's group or the person's own space, for those who may add apps there", async () => {
    const w = world();
    const id = await w.published();
    work(w.db, w.sam.id, w.noa.id);
    expect((await w.addCopy(SAM, "work", id)).status).toBe(404); // a group of his, not the listing's
    expect((await w.addCopy(SAM, w.linsSpace, id)).status).toBe(404); // someone else's personal space
    expect((await w.addCopy(LIN, "family", id)).status).toBe(403); // may not add apps there

    // Sam's copy in the family, "only me for now": Kim cannot see it, and still the space has one.
    const sams = await w.addCopy(SAM, "family", id);
    expect(sams.status).toBe(201);
    const { appId } = (await sams.json()) as { appId: string };
    expect(stored(w.db, appId)).toMatchObject({ spaceId: "family", memberAccess: "none" });
    expect((await w.appsOf(KIM)).some((app) => app.id === appId)).toBe(false);
    expect((await w.addCopy(KIM, "family", id)).status).toBe(409);
    expect((await w.addCopy(SAM, "family", id)).status).toBe(409);
    // Someone who may not add apps there hears no more than that.
    expect((await w.addCopy(LIN, "family", id)).status).toBe(403);

    // A member who may add apps adds one to her own space, with "view" for nobody else to use.
    const kims = await w.addCopy(KIM, w.kimsSpace, id, { memberAccess: "view" });
    expect(kims.status).toBe(201);
    expect(stored(w.db, ((await kims.json()) as { appId: string }).appId)).toMatchObject({ spaceId: w.kimsSpace, memberAccess: "view" });
    expect((await w.addCopy(KIM, w.kimsSpace, id, { memberAccess: "loud" })).status).toBe(400);
  });

  it("brings back the copy a space removed, with its entries", async () => {
    const w = world();
    const id = await w.published();
    const { appId } = (await (await w.addCopy(SAM, w.samsSpace, id)).json()) as { appId: string };
    const rows = `/api/spaces/${w.samsSpace}/apps/${appId}/rows/items`;
    expect((await w.call(SAM, rows, { method: "POST", body: { data: { name: "Milk" } } })).status).toBe(201);
    expect((await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}`, { method: "DELETE" })).status).toBe(204);

    const back = await w.addCopy(SAM, w.samsSpace, id);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ appId, restored: true });
    expect(((await (await w.call(SAM, rows)).json()) as { rows: { name: string }[] }).rows.map((row) => row.name)).toEqual(["Milk"]);
    expect(w.db.prepare("SELECT count(*) AS n FROM made_apps WHERE space_id = ?").get(w.samsSpace)).toEqual({ n: 1 });
  });
});

describe("moving a copy", () => {
  it("into a group is refused while nobody changed it; into a personal space, or changed first, it moves", async () => {
    const w = world();
    const id = await w.published();
    const move = (email: string, spaceId: string, appId: string, toSpaceId: string) =>
      w.call(email, `/api/spaces/${spaceId}/apps/${appId}/move`, { method: "POST", body: { toSpaceId } });

    const kims = ((await (await w.addCopy(KIM, w.kimsSpace, id)).json()) as { appId: string }).appId;
    const refused = await move(KIM, w.kimsSpace, kims, "family");
    expect(refused.status).toBe(409);
    expect(await refused.text()).toMatch(/app center/);
    expect(stored(w.db, kims)).toMatchObject({ spaceId: w.kimsSpace });

    // Sam's copy in the family moves to his own space as it is.
    const sams = ((await (await w.addCopy(SAM, "family", id)).json()) as { appId: string }).appId;
    expect((await move(SAM, "family", sams, w.samsSpace)).status).toBe(204);
    expect(stored(w.db, sams)).toMatchObject({ spaceId: w.samsSpace });

    // Changed by one character, Kim's copy is hers, and moves like any app she made.
    setPage(w.db, kims, `${PAGE} `);
    expect((await move(KIM, w.kimsSpace, kims, "family")).status).toBe(204);
    expect(stored(w.db, kims)).toMatchObject({ spaceId: "family" });
  });
});

describe("a copy, its listing and its source", () => {
  it("are independent: publishing again, deleting the source, unpublishing and deleting a copy each leave the others", async () => {
    const w = world();
    const id = await w.published();
    const { appId } = (await (await w.addCopy(SAM, w.samsSpace, id)).json()) as { appId: string };
    const rows = `/api/spaces/${w.samsSpace}/apps/${appId}/rows/items`;
    expect((await w.call(SAM, rows, { method: "POST", body: { data: { name: "Bread" } } })).status).toBe(201);

    // Publishing again leaves the copy as it was.
    setPage(w.db, LEDGER, "<!doctype html><p>Second</p>");
    expect((await w.publish(LIN, w.linsSpace, LEDGER)).status).toBe(200);
    expect(stored(w.db, appId)).toMatchObject({ html: PAGE, originRevision: 1, version: 1 });

    // Deleting the source leaves the listing, which can still be added.
    const gone = await w.call(LIN, `/api/spaces/${w.linsSpace}/apps/${LEDGER}/data`, { method: "DELETE", body: { confirm: "Checklist" } });
    expect(gone.status).toBe(204);
    expect((await w.center(SAM)).listings.map((listing) => listing.id)).toEqual([id]);
    const kims = await w.addCopy(KIM, w.kimsSpace, id);
    expect(kims.status).toBe(201);
    const kimsCopy = ((await kims.json()) as { appId: string }).appId;
    expect(stored(w.db, kimsCopy)).toMatchObject({ html: "<!doctype html><p>Second</p>", originRevision: 2 });

    // Deleting a copy leaves the listing.
    const deleted = await w.call(KIM, `/api/spaces/${w.kimsSpace}/apps/${kimsCopy}/data`, { method: "DELETE", body: { confirm: "清单" } });
    expect(deleted.status).toBe(204);
    expect((await w.center(KIM)).listings.map((listing) => listing.id)).toEqual([id]);

    // Unpublishing leaves the copy working, with its entries, and no longer shared.
    expect((await w.call(LIN, `/api/center/${id}`, { method: "DELETE" })).status).toBe(204);
    expect(stored(w.db, appId)).toMatchObject({ origin: null, originHash: templateHash(CHECKLIST, PAGE), originRevision: 1 });
    expect(((await (await w.call(SAM, rows)).json()) as { rows: { name: string }[] }).rows.map((row) => row.name)).toEqual(["Bread"]);
    expect((await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}/frame`)).status).toBe(200);
    expect((await w.appsOf(SAM)).find((app) => app.id === appId)?.source).toEqual({ untouched: true });
    expect(w.errors).toEqual([]);
  });
});

describe("the publisher's name beside a copy", () => {
  it("is shown only to members of the listing's group", async () => {
    const w = world();
    const id = await w.published();
    work(w.db, w.sam.id, w.noa.id);
    const { appId } = (await (await w.addCopy(SAM, w.samsSpace, id)).json()) as { appId: string };
    // Changed, it is Sam's, and he moves it to Work, where Noa may view it.
    setPage(w.db, appId, `${PAGE} `);
    const moved = await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}/move`, {
      method: "POST",
      body: { toSpaceId: "work", memberAccess: "view" },
    });
    expect(moved.status).toBe(204);
    const sourceFor = async (email: string) => (await w.appsOf(email)).find((app: AppSummary) => app.id === appId)?.source;
    expect(await sourceFor(SAM)).toEqual({ listingId: id, by: "lin" });
    expect(await sourceFor(NOA)).toEqual({ listingId: id });
    expect(JSON.stringify(await w.appsOf(NOA))).not.toContain('"by"');
  });

  it("says when the viewer is the publisher, and whether the copy is still as it was shared", async () => {
    const w = world();
    const id = await w.published();
    // Lin adds a copy of her own app: it is "an app you shared" to her.
    const { appId } = (await (await w.addCopy(LIN, w.linsSpace, id)).json()) as { appId: string };
    const source = async () => (await w.appsOf(LIN)).find((app: AppSummary) => app.id === appId)?.source;
    expect(await source()).toEqual({ listingId: id, by: "lin", mine: true, untouched: true });
    setPage(w.db, appId, `${PAGE} `);
    expect(await source()).toEqual({ listingId: id, by: "lin", mine: true });
  });
});

describe("what leaves when an app is published", () => {
  it("is its manifest and page: no entry, setting value, version note, email address or other person's ID", async () => {
    const w = world();
    const registry = madeAppsRegistry(w.db);
    const base = `/api/spaces/${w.linsSpace}/apps/${LEDGER}`;
    expect((await w.call(LIN, `${base}/rows/items`, { method: "POST", body: { data: { name: "A gift for Sam" } } })).status).toBe(201);
    const settings = await w.call(LIN, `${base}/settings`, {
      method: "PATCH",
      body: { space: { sections: ["Bottom drawer"] }, user: { hideDone: true } },
    });
    expect(settings.status).toBe(200);
    changeMadeApp(w.db, registry, {
      userId: w.lin.id,
      spaceId: w.linsSpace,
      appId: LEDGER,
      by: "person",
      html: "<!doctype html><p>Ledger</p>",
      note: "Hid the birthday list",
    });
    const id = await w.published();
    const { appId } = (await (await w.addCopy(SAM, w.samsSpace, id)).json()) as { appId: string };

    const row = w.db.prepare("SELECT * FROM published_apps WHERE id = ?").get(id) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual(
      ["created_at", "created_by", "hash", "html", "id", "manifest", "note", "revision", "source_app_id", "source_space_id", "space_id", "updated_at"].sort(),
    );
    const answers = [
      JSON.stringify(row),
      JSON.stringify(await w.center(SAM)),
      JSON.stringify(await w.center(LIN)),
      JSON.stringify(await w.review(LIN, w.linsSpace, LEDGER)),
      JSON.stringify(await (await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}/settings`)).json()),
      JSON.stringify(await (await w.call(SAM, `/api/spaces/${w.samsSpace}/apps/${appId}/rows/items`)).json()),
    ];
    for (const text of answers) {
      for (const secret of ["A gift for Sam", "Bottom drawer", "Hid the birthday list", "@", w.sam.id, w.kim.id, w.noa.id]) {
        expect(text, secret).not.toContain(secret);
      }
    }
    // The copy's own versions start afresh.
    expect(w.db.prepare("SELECT version, note FROM made_app_versions WHERE app_id = ?").all(appId)).toEqual([
      { version: 1, note: "Copy of “Checklist” (revision 1)" },
    ]);
  });
});
