/**
 * The framework's own sample apps (packages/fixture-apps) as the server's
 * tests are handed them: the one that has no server file, and the one with
 * a job.
 *
 * A real build gets its list of apps from `hearth-apps sync`; tests get
 * `FIXTURE_APPS`, written by hand in ../testing.ts. The first test keeps the
 * hand-written list equal to what sync would write for that folder.
 */
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { apiErrorSchema, appCallResponseSchema, appSettingsSchema, jobStatusSchema, sessionSchema } from "@hearth/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { as, FIXTURE_APPS, testApp } from "../testing";
import { processClock, standInResponse, type Outbound } from "./fetch";
import { runOnce } from "./jobs";
import { createRegistry } from "./registry";
import { family, install, LIN, SAM } from "./test-world";

const BASE = "http://hearth.example.com";
const FIXTURES = resolve(import.meta.dirname, "../../../fixture-apps");

describe("the sample apps handed to tests", () => {
  it("are the folders of packages/fixture-apps, as a build finds them", () => {
    const folders = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(FIXTURES, entry.name, "manifest.ts")))
      .map((entry) => entry.name)
      .sort();
    expect(FIXTURE_APPS.map((app) => app.id)).toEqual(folders);
    for (const app of FIXTURE_APPS) {
      expect(app.manifest.id).toBe(app.id);
      expect([app.id, app.server !== undefined]).toEqual([app.id, existsSync(join(FIXTURES, app.id, "server.ts"))]);
      expect([app.id, app.hasPage]).toEqual([app.id, existsSync(join(FIXTURES, app.id, "page.tsx"))]);
    }
  });
});

describe("the sample feed, an app with a widget and no server file", () => {
  let world: ReturnType<typeof family>;
  let app: ReturnType<typeof testApp>["app"];
  let errors: unknown[];

  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: as(who, body === undefined ? {} : { "content-type": "application/json", origin: BASE }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const settings = async (response: Response) => {
    expect(response.status).toBe(200);
    return appSettingsSchema.parse(await response.json());
  };

  beforeEach(() => {
    world = family();
    ({ app, errors } = testApp({ db: world.db, apps: FIXTURE_APPS }));
    install(world.db, world.family, "feed", world.sam.id, { memberAccess: "view" });
  });

  it("is in the session of everyone it is shared with, as an app without a page", async () => {
    for (const who of [SAM, LIN]) {
      const session = sessionSchema.parse(await (await call(who, "GET", "/api/session")).json());
      expect(session.apps).toEqual([
        expect.objectContaining({ id: "feed", spaceId: world.family, hasPage: false, widgetSize: "wide", icon: "trending-up" }),
      ]);
    }
  });

  it("has no queries or mutations to call", async () => {
    for (const kind of ["q", "m"]) {
      const response = await call(SAM, "POST", `/api/spaces/${world.family}/apps/feed/${kind}/list`, {});
      expect(response.status).toBe(404);
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe("not_found");
    }
    expect(errors).toEqual([]);
  });

  it("keeps each person's own filters, which a viewer may change too", async () => {
    const address = `/api/spaces/${world.family}/apps/feed/settings`;
    expect(await settings(await call(LIN, "GET", address))).toEqual({ space: {}, user: { topics: [], period: "day" } });

    const saved = await settings(await call(LIN, "PATCH", address, { user: { topics: ["food", "science"], period: "week" } }));
    expect(saved).toEqual({ space: {}, user: { topics: ["food", "science"], period: "week" } });
    expect(await settings(await call(SAM, "GET", address))).toEqual({ space: {}, user: { topics: [], period: "day" } });

    const unknownTopic = await call(LIN, "PATCH", address, { user: { topics: ["gossip"] } });
    expect(unknownTopic.status).toBe(400);
    expect(errors).toEqual([]);
  });
});

describe("the sample headlines, an app with a job", () => {
  let world: ReturnType<typeof family>;
  let app: ReturnType<typeof testApp>["app"];
  let errors: unknown[];

  const call = (who: string, method: string, path: string, body?: unknown) =>
    app.request(`${BASE}${path}`, {
      method,
      headers: as(who, body === undefined ? {} : { "content-type": "application/json", origin: BASE }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const address = () => `/api/spaces/${world.family}/apps/headlines`;
  const latest = async (who: string) => {
    const response = await call(who, "POST", `${address()}/q/latest`, {});
    expect(response.status).toBe(200);
    return appCallResponseSchema.parse(await response.json()).output as { title: string; createdBy: string }[];
  };
  const status = async (who: string) => {
    const response = await call(who, "GET", `${address()}/jobs/refresh`);
    expect(response.status).toBe(200);
    return jobStatusSchema.parse(await response.json());
  };

  beforeEach(() => {
    world = family();
    ({ app, errors } = testApp({ db: world.db, apps: FIXTURE_APPS }));
    // Sam added the headlines to the family, for every member to view.
    install(world.db, world.family, "headlines", world.sam.id, { memberAccess: "view" });
  });

  it("has no headlines before its job first ran, and says the job has not run", async () => {
    expect(await latest(LIN)).toEqual([]);
    expect(await status(LIN)).toMatchObject({ lastStartedAt: null, lastSucceededAt: null, lastFailedAt: null, state: "idle" });
    expect(errors).toEqual([]);
  });

  it("keeps the feed's headlines once its job ran as the scheduler runs it, in the name of whoever added it", async () => {
    const asked: string[] = [];
    const outbound: Outbound = {
      transport: async ({ url }) => {
        asked.push(url);
        return standInResponse({ body: { items: [{ title: "Rain expected" }, { title: "Market opens" }] } });
      },
      pace: null,
      clock: processClock,
    };
    const outcome = await runOnce(
      world.db,
      createRegistry(FIXTURE_APPS),
      { spaceId: world.family, appId: "headlines", job: "refresh" },
      { outbound, clock: processClock, now: () => new Date(), random: () => 0 },
    );

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(asked).toEqual(["https://feeds.example.com/headlines.json"]);
    expect(await latest(LIN)).toEqual([
      expect.objectContaining({ title: "Rain expected", createdBy: world.sam.id }),
      expect.objectContaining({ title: "Market opens", createdBy: world.sam.id }),
    ]);
    expect(await status(LIN)).toMatchObject({ lastSucceededAt: expect.any(String), lastFailedAt: null, state: "idle" });

    // Lin may only view: she reads how it went, and cannot ask for a run. Sam can.
    const refused = await call(LIN, "POST", `${address()}/jobs/refresh/run`);
    expect(refused.status).toBe(403);
    expect(apiErrorSchema.parse(await refused.json()).error.code).toBe("forbidden");
    const asks = await call(SAM, "POST", `${address()}/jobs/refresh/run`);
    expect(asks.status).toBe(202);
    expect(jobStatusSchema.parse(await asks.json()).state).toBe("requested");
    // The job is no route.
    expect((await call(SAM, "POST", `${address()}/q/refresh`, {})).status).toBe(404);
    expect(errors).toEqual([]);
  });
});
