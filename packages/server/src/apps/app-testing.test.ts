/**
 * `testApp` from `@hearth/sdk/testing` with the framework's implementation
 * (app-testing.ts), as `hearth-apps test` hands it over: what a mini-app's
 * own tests rely on. The command itself, running an app's test files, is
 * tested in packages/sdk/tools/cli.test.ts.
 */
import { defineApp } from "@hearth/sdk";
import { AppError, defineServer, z } from "@hearth/sdk/server";
import { AppCallError, testApp } from "@hearth/sdk/testing";
import { provideTestApp, type TestCallerHandle } from "@hearth/sdk/testing/host";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import checklist from "../../../fixture-apps/checklist/server";
import { DEFAULT_PERSON, TEST_GROUP_NAME, createTestApp } from "./app-testing";
import { AppFaultError } from "./calls";

beforeAll(() => provideTestApp(createTestApp));
afterAll(() => provideTestApp(null));

const notes = defineApp({
  id: "notes",
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
  settings: {
    title: { type: "text", scope: "space", default: "Notes", maxLength: 20, label: { en: "Title", zh: "标题" } },
    size: { type: "number", scope: "user", default: 12, min: 8, max: 24, step: 1, label: { en: "Size", zh: "大小" } },
  },
});

const app = defineServer(notes, { notes: z.object({ text: z.string().min(1), at: z.string().default("") }) });

const server = app.routes({
  whoami: app.query({ description: "Says who is asking, where and with which access." }, (ctx) => ({
    id: ctx.user.id,
    name: ctx.user.name,
    locale: ctx.locale,
    space: ctx.space,
    access: ctx.access,
    settings: ctx.settings,
  })),
  mine: app.query({ description: "Lists the notes the caller wrote." }, (ctx) => ctx.db.notes.list({ mine: true })),
  all: app.query({ description: "Lists every note." }, (ctx) => ctx.db.notes.list()),
  write: app.mutation(
    { description: "Writes a note, with when it is about.", input: z.object({ text: z.string(), at: z.string().default("") }) },
    (ctx, input) => ctx.db.notes.insert(input),
  ),
  taken: app.mutation({ description: "Turns every request down as a conflict." }, () => {
    throw new AppError("conflict", "That note is taken.");
  }),
  broken: app.query({ description: "Fails, as a bug in an app would." }, () => {
    throw new Error("A bug.");
  }),
  later: app.query({ description: "Answers with a promise, which no handler may." }, () => Promise.resolve(1) as never),
});

describe("testApp with the framework's implementation", () => {
  it("calls queries and mutations as the server answers them, with the store of a database of its own", () => {
    const world = testApp(checklist);
    expect(world.space).toEqual({ kind: "group", name: TEST_GROUP_NAME });
    const sam = world.as();
    expect(sam.user.name).toBe(DEFAULT_PERSON);

    const milk = sam.mutation("add", { name: " Milk " });
    expect(milk).toMatchObject({ name: "Milk", section: "", done: false, createdBy: sam.user.id, updatedBy: sam.user.id });
    expect(sam.query("list")).toEqual([milk]);
    expect(sam.mutation("clearTicked")).toBe(0);

    // Every testApp starts empty.
    expect(testApp(checklist).as().query("list")).toEqual([]);
  });

  it("is one person for one name, with the name, language and access asked for", () => {
    const world = testApp(server);
    const lin = world.as({ name: "Lin", locale: "zh", access: "view" });
    const sam = world.as({ name: "Sam" });

    expect(lin.query("whoami")).toEqual({
      id: lin.user.id,
      name: "Lin",
      locale: "zh",
      space: { kind: "group", name: TEST_GROUP_NAME },
      access: "view",
      settings: { title: "Notes", size: 12 },
    });
    expect(sam.query("whoami")).toMatchObject({ name: "Sam", locale: "en", access: "edit" });
    expect(sam.user.id).not.toBe(lin.user.id);

    // The same Lin, now with edit: her notes are hers, whichever caller wrote them.
    const linEdits = world.as({ name: "Lin" });
    expect(linEdits.user).toEqual(lin.user);
    linEdits.mutation("write", { text: "Lin's" });
    sam.mutation("write", { text: "Sam's" });
    expect(lin.query("mine").map((note) => note.text)).toEqual(["Lin's"]);
    expect(lin.query("all").map((note) => note.text)).toEqual(["Lin's", "Sam's"]);
    // And each caller keeps the access it was made with.
    expect(() => lin.mutation("write", { text: "Not with view" })).toThrow(AppCallError);
    expect(lin.query("whoami")).toMatchObject({ access: "view", locale: "zh" });
  });

  it("turns calls down as the routes do, with the code first in the message", () => {
    const viewer = testApp(server).as({ access: "view" });
    const refusal = (call: () => unknown) => {
      try {
        call();
      } catch (error) {
        return error;
      }
      throw new Error("The call was not turned down.");
    };

    expect(refusal(() => viewer.mutation("write", { text: "x" }))).toMatchObject({
      name: "AppCallError",
      status: 403,
      code: "forbidden",
      message: "forbidden: Changing anything in this app needs edit access to it.",
    });
    const editor = testApp(server).as();
    // What the types would not let a test write, as a caller that ignores them would send it.
    const untyped = editor as unknown as TestCallerHandle;
    expect(refusal(() => editor.mutation("write", { text: "" }))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(refusal(() => editor.mutation("write", { text: 1 } as never))).toMatchObject({ status: 400, code: "invalid_request" });
    expect(refusal(() => untyped.query("nope"))).toMatchObject({ status: 404, code: "not_found" });
    // A mutation is not there as a query, nor the other way round.
    expect(refusal(() => untyped.query("write", { text: "x" }))).toMatchObject({ code: "not_found" });
    expect(refusal(() => untyped.mutation("all"))).toMatchObject({ code: "not_found" });
    expect(refusal(() => editor.mutation("taken"))).toMatchObject({ status: 409, code: "conflict", message: "conflict: That note is taken." });
    expect(refusal(() => untyped.query("all", {}))).toMatchObject({
      code: "invalid_request",
      message: "invalid_request: input: This route takes no input.",
    });
    expect(editor.query("all")).toEqual([]);
  });

  it("sends the input through JSON, as a browser does", () => {
    const sam = testApp(server).as();
    const note = sam.mutation("write", { text: "Dentist", at: new Date(Date.UTC(2026, 0, 2)) as unknown as string });
    expect(note.at).toBe("2026-01-02T00:00:00.000Z");
    // Undefined is left out, so the schema's default applies.
    expect(sam.mutation("write", { text: "Later", at: undefined })).toMatchObject({ at: "" });
  });

  it("gives a handler's fault as the error the server would log, so the test fails", () => {
    const sam = testApp(server).as();
    expect(() => sam.query("broken")).toThrow(AppFaultError);
    expect(() => sam.query("broken")).toThrow('Mini-app "notes": the query "broken" failed.');
    expect(() => sam.query("later")).toThrow("returned a promise");
  });

  it("reads and saves settings by name, each under its scope, as the settings routes do", () => {
    const world = testApp(server);
    const sam = world.as({ name: "Sam" });
    const lin = world.as({ name: "Lin", access: "view" });

    expect(lin.settings()).toEqual({ title: "Notes", size: 12 });
    expect(sam.saveSettings({ title: "Family notes", size: 16 })).toEqual({ title: "Family notes", size: 16 });
    // The space's title is everyone's; the size was Sam's own.
    expect(lin.settings()).toEqual({ title: "Family notes", size: 12 });
    expect(lin.query("whoami")).toMatchObject({ settings: { title: "Family notes", size: 12 } });

    // View access saves a person's own, and not the space's.
    expect(lin.saveSettings({ size: 20 })).toEqual({ title: "Family notes", size: 20 });
    expect(() => lin.saveSettings({ title: "Mine" })).toThrow("forbidden");
    expect(() => lin.saveSettings({ title: "Mine", size: 9 })).toThrow("forbidden");
    expect(lin.settings()).toEqual({ title: "Family notes", size: 20 });

    // Names and values are checked against the manifest.
    expect(() => sam.saveSettings({ colour: "red" } as never)).toThrow("invalid_request: user.colour: This app has no setting");
    expect(() => sam.saveSettings({ size: 30 })).toThrow("invalid_request: user.size:");
    expect(() => sam.saveSettings({ size: { big: true } } as never)).toThrow("invalid_request");
    expect(sam.settings()).toEqual({ title: "Family notes", size: 16 });
  });

  it("puts an app that allows only personal spaces in one, with its one person", () => {
    const journal = defineApp({ ...notes, id: "journal", spaces: ["personal"] });
    const journalApp = defineServer(journal, {});
    const journalServer = journalApp.routes({
      whoami: journalApp.query({ description: "Says who is asking and where." }, (ctx) => ({ name: ctx.user.name, space: ctx.space, access: ctx.access })),
    });

    const world = testApp(journalServer);
    expect(world.space).toEqual({ kind: "personal", name: "" });
    expect(world.as({ name: "Kim" }).query("whoami")).toEqual({ name: "Kim", space: { kind: "personal", name: "" }, access: "edit" });
    expect(world.as({ name: "Kim" }).query("whoami")).toMatchObject({ name: "Kim" });
    expect(() => world.as({ name: "Lin" })).toThrow("a personal space has one person, Kim");
    expect(() => world.as({ name: "Kim", access: "view" })).toThrow("may always edit");
    expect(() => testApp(journalServer, { space: "group" })).toThrow("cannot be added to a group space");

    // An app that allows both may be put in a personal space when asked.
    expect(testApp(server, { space: "personal" }).as().query("whoami")).toMatchObject({
      space: { kind: "personal", name: "" },
      access: "edit",
    });
  });

  it("refuses an app the server would refuse at start-up, and anything that is not a server file", () => {
    const silent = { ...server, routes: { ...server.routes, all: { ...server.routes.all, description: " " } } };
    expect(() => testApp(silent)).toThrow(/the server would not start with this app:\n {2}- App "notes": server route "all": Needs a description/);
    expect(() => testApp(notes as never)).toThrow("testApp takes what an app's server.ts exports");
    expect(() => testApp(server).as({ name: "" })).toThrow("needs a name");
    expect(() => testApp(server).as({ access: "own" as never })).toThrow('"view" or "edit"');
  });
});
