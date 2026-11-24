/**
 * The app center through its routes (docs/center.md, "Tests"): who may
 * publish an app, what refuses it, publishing again, unpublishing, and
 * listings going with their publisher's membership. Sample people of
 * test-world: Sam owns the server and the group "family", Lin is a plain
 * member, Kim a member who may add apps, Noa is in no group with them.
 */
import { MAX_LISTINGS_PER_GROUP, type PublishReview } from "@hearth/shared";
import { describe, expect, it } from "vitest";
import { CHECKLIST, family, grant, KIM, LIN, makeApp, NOA, NOW, PAGE, SAM } from "../apps/test-world";
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
  return { ...people, call, publish, review, errors };
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

  it("is the email address of the publisher or of someone they share a space with, named by where and not whose", async () => {
    const w = world();
    const manifest = madeManifestSchema.parse({ ...CHECKLIST, instructions: "Ask LIN@Example.com before deleting." });
    makeApp(w.db, w.linsSpace, "m-email00001", w.lin.id, {
      manifest,
      html: "<!doctype html>\n<p>Hello</p>\n<p>Write to owner@example.com.</p>\n<p>not jimowner@example.com, nor owner@example.com.au</p>",
    });
    expect((await w.review(LIN, w.linsSpace, "m-email00001")).problems).toEqual([
      { code: "email", where: { part: "instructions" } },
      { code: "email", where: { part: "page", line: 3 } },
    ]);
    const refused = await w.publish(LIN, w.linsSpace, "m-email00001");
    expect(refused.status).toBe(400);
    const message = await refused.text();
    expect(message).toMatch(/the instructions.*the page, line 3/);
    expect(message).not.toMatch(/example\.com/i);

    // Noa shares no space with Lin: her address is not looked for, so its presence says nothing about her.
    setPage(w.db, "m-email00001", "<!doctype html><p>noa@example.com</p>");
    w.db.prepare("UPDATE made_apps SET manifest = ? WHERE app_id = 'm-email00001'").run(JSON.stringify(CHECKLIST));
    expect((await w.review(LIN, w.linsSpace, "m-email00001")).problems).toEqual([]);
    expect((await w.publish(LIN, w.linsSpace, "m-email00001")).status).toBe(201);
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
