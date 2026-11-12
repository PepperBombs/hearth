import { testApp, type StandInAnswer, type StandInRequest } from "@hearth/sdk/testing";
import { describe, expect, it } from "vitest";
import server from "./server";

const FEED = "https://feeds.example.com/headlines.json";

/** The sample feed's answer with these titles. */
const feed = (...titles: string[]): StandInAnswer => ({ body: { items: titles.map((title) => ({ title })) } });

const titles = (rows: readonly { title: string }[]) => rows.map((row) => row.title);

describe("headlines", () => {
  it("fetches the feed and keeps its first five headlines, in its order, for everyone in the space", async () => {
    const app = testApp(server);
    const lin = app.as({ name: "Lin", access: "view" });
    const asked: StandInRequest[] = [];
    expect(lin.query("latest")).toEqual([]);

    const run = await app.runJob("refresh", {
      fetch: (request) => {
        asked.push(request);
        return feed("One", "Two", "Three", "Four", "Five", "Six", "Seven");
      },
    });

    expect(run).toEqual({ ok: true, error: null });
    // One request, to the host the manifest lists, as Hearth, asking for JSON.
    expect(asked).toEqual([{ url: FEED, headers: { "user-agent": "Hearth", accept: "application/json" } }]);
    expect(titles(lin.query("latest"))).toEqual(["One", "Two", "Three", "Four", "Five"]);
  });

  it("puts what a later run fetched in place of what an earlier one kept", async () => {
    const app = testApp(server);
    await app.runJob("refresh", { fetch: () => feed("Rain expected", "Market opens") });
    await app.runJob("refresh", { fetch: () => feed("Snow in the hills") });
    expect(titles(app.as().query("latest"))).toEqual(["Snow in the hills"]);
  });

  it("keeps the headlines it has when the feed fails, and says when the runs ended", async () => {
    const app = testApp(server);
    const lin = app.as({ name: "Lin", access: "view" });
    const first = new Date("2026-03-01T13:05:00.000Z");
    const second = new Date("2026-03-01T14:05:00.000Z");
    expect(lin.job("refresh")).toEqual({ succeededAt: null, failedAt: null, running: false, canRun: false });

    expect(await app.runJob("refresh", { now: first, fetch: () => feed("Rain expected", "Market opens") })).toEqual({ ok: true, error: null });
    expect(lin.job("refresh")).toEqual({ succeededAt: first.toISOString(), failedAt: null, running: false, canRun: false });

    expect(await app.runJob("refresh", { now: second, fetch: () => ({ status: 503 }) })).toEqual({
      ok: false,
      error: "The feed answered 503.",
    });
    expect(titles(lin.query("latest"))).toEqual(["Rain expected", "Market opens"]);
    // "Couldn't reach the feed at 14:05. Showing headlines from 13:05."
    expect(lin.job("refresh")).toEqual({
      succeededAt: first.toISOString(),
      failedAt: second.toISOString(),
      running: false,
      canRun: false,
    });
  });

  it("fails a run when the feed cannot be reached or does not answer with a list of headlines", async () => {
    const app = testApp(server);
    await app.runJob("refresh", { fetch: () => feed("Rain expected") });
    const failures: [string, () => StandInAnswer, string | RegExp][] = [
      [
        "no connection",
        () => {
          throw new Error("Connection reset");
        },
        "Could not reach feeds.example.com (Connection reset).",
      ],
      ["a page that is not JSON", () => ({ body: "<html>Down for maintenance</html>" }), /^The answer from https:\/\/feeds\.example\.com\/headlines\.json is not JSON/],
      ["no list", () => ({ body: { items: "none" } }), "The feed's answer is not a list of headlines."],
      ["items without a title", () => ({ body: { items: [{ headline: "Rain expected" }] } }), "The feed's answer is not a list of headlines."],
      ["a page that is gone", () => ({ status: 404, body: { error: "Not found" } }), "The feed answered 404."],
    ];
    for (const [what, fetch, error] of failures) {
      const run = await app.runJob("refresh", { fetch });
      expect([what, run.ok]).toEqual([what, false]);
      expect(run.error).toMatch(error);
    }
    expect(titles(app.as().query("latest"))).toEqual(["Rain expected"]);
  });

  it("keeps each title on one line, cuts a long one and passes over an empty one", async () => {
    const app = testApp(server);
    const long = `${"Long ".repeat(50)}story`;
    await app.runJob("refresh", { fetch: () => feed("  Rain\n expected \t tonight ", " \n ", long, "😀".repeat(150)) });

    const kept = titles(app.as().query("latest"));
    expect(kept).toEqual(["Rain expected tonight", `${long.slice(0, 199)}…`, `${"😀".repeat(99)}…`]);
    expect(kept[1]).toHaveLength(200);
  });

  it("lets someone who may edit ask for a run now, and no one who may only view", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin", access: "view" });

    expect(() => lin.requestRun("refresh")).toThrow("forbidden");
    expect(sam.requestRun("refresh")).toEqual({ succeededAt: null, failedAt: null, running: true, canRun: true });
    // Lin sees the run coming too, on her widget as "Refreshing…".
    expect(lin.job("refresh")).toEqual({ succeededAt: null, failedAt: null, running: true, canRun: false });
  });

  it("runs in a personal space, for its one person", async () => {
    const app = testApp(server, { space: "personal" });
    const sam = app.as({ name: "Sam" });
    expect(await app.runJob("refresh", { fetch: () => feed("Rain expected") })).toEqual({ ok: true, error: null });
    expect(titles(sam.query("latest"))).toEqual(["Rain expected"]);
    expect(sam.job("refresh")).toMatchObject({ failedAt: null, running: false, canRun: true });
  });
});
