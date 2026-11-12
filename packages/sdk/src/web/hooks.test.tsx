/**
 * `appHooks`: its types, and that the hooks hand through what the scope
 * around the widget gives. As in ../index.test.ts, the type tests are
 * checked by `pnpm typecheck`, not by the test runner.
 */
import { render, screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { defineApp } from "../index";
import { defineServer, z, type Row } from "../server";
import { appHooks, type InputArgs, type JobName, type JobState, type MutationName, type Output, type QueryName } from "./index";
import { AppScopeContext, type AppScopeValue } from "./scope";

const manifest = defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  widget: { size: "tall" },
  settings: {
    aisles: { type: "list", scope: "space", default: [], label: { en: "Aisles", zh: "货架" } },
    hideDone: { type: "switch", scope: "user", default: false, label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" } },
  },
  messages: {
    en: { empty: "Nothing to buy.", left: "{count} left" },
    zh: { empty: "没有要买的东西。", left: "还剩 {count} 项" },
  },
});

const app = defineServer(manifest, {
  items: z.object({ name: z.string().min(1), aisle: z.string().default(""), done: z.boolean().default(false) }),
});
type Item = Row<{ name: string; aisle: string; done: boolean }>;

const server = app.routes({
  list: app.query({ description: "Lists every item, oldest first." }, (ctx) => ctx.db.items.list()),
  inAisle: app.query(
    { description: "Lists the items of one aisle.", input: z.object({ aisle: z.string() }) },
    (ctx, input) => ctx.db.items.list({ where: { aisle: input.aisle } }),
  ),
  recent: app.query(
    { description: "Lists the newest items.", input: z.object({ limit: z.number().default(5) }).optional() },
    (ctx, input) => ctx.db.items.list({ desc: true, limit: input?.limit ?? 5 }),
  ),
  add: app.mutation(
    { description: "Adds an item to the list.", input: z.object({ name: z.string(), aisle: z.string().default("") }) },
    (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
  ),
  clearTicked: app.mutation({ description: "Deletes every ticked item and says how many went." }, (ctx) =>
    ctx.db.items.removeWhere({ done: true }),
  ),
  touch: app.mutation({ description: "Does nothing and answers nothing." }, () => {}),
  tidy: app.job({ description: "Deletes every ticked item, once an hour.", everyMinutes: 60 }, (ctx) => {
    ctx.write((db) => db.items.removeWhere({ done: true }));
  }),
});
type Server = typeof server;

const { useApp, useQuery, useMutation, useJob } = appHooks<Server>();

describe("the types of an app's hooks", () => {
  it("name the app's queries, mutations and jobs, each kind apart", () => {
    expectTypeOf<QueryName<Server>>().toEqualTypeOf<"list" | "inAisle" | "recent">();
    expectTypeOf<MutationName<Server>>().toEqualTypeOf<"add" | "clearTicked" | "touch">();
    expectTypeOf<JobName<Server>>().toEqualTypeOf<"tidy">();
  });

  it("take what the route takes: nothing, its input, or an input that may be left out", () => {
    expectTypeOf<InputArgs<Server, "list">>().toEqualTypeOf<[]>();
    expectTypeOf<InputArgs<Server, "inAisle">>().toEqualTypeOf<[input: { aisle: string }]>();
    expectTypeOf<InputArgs<Server, "recent">>().toEqualTypeOf<[input?: { limit?: number | undefined } | undefined]>();
    // What the caller sends is the schema's input: a field with a default may be left out.
    expectTypeOf<InputArgs<Server, "add">>().toEqualTypeOf<[input: { name: string; aisle?: string | undefined }]>();
    expectTypeOf<InputArgs<Server, "clearTicked">>().toEqualTypeOf<[]>();
  });

  it("answer with what the route's handler returns", () => {
    expectTypeOf<Output<Server, "list">>().toEqualTypeOf<Item[]>();
    expectTypeOf<Output<Server, "add">>().toEqualTypeOf<Item>();
    expectTypeOf<Output<Server, "clearTicked">>().toEqualTypeOf<number>();
    expectTypeOf<Output<Server, "touch">>().toEqualTypeOf<void>();
  });

  it("are checked where a widget calls them", () => {
    // Never run: hooks only work while a component renders. The compiler reads it all the same.
    function Widget() {
      const { t, settings, canEdit, access, locale, user, space, pagePath } = useApp();
      expectTypeOf(settings).toEqualTypeOf<{ aisles: string[]; hideDone: boolean }>();
      expectTypeOf(canEdit).toEqualTypeOf<boolean>();
      expectTypeOf(access).toEqualTypeOf<"view" | "edit">();
      expectTypeOf(locale).toEqualTypeOf<"en" | "zh">();
      expectTypeOf(user).toEqualTypeOf<{ id: string; name: string }>();
      expectTypeOf(space.kind).toEqualTypeOf<"personal" | "group">();
      expectTypeOf(space.members).toEqualTypeOf<{ id: string; name: string }[]>();
      expectTypeOf(pagePath).toEqualTypeOf<string | null>();

      expectTypeOf(t("empty")).toEqualTypeOf<string>();
      t("left", { count: 3 });
      // @ts-expect-error: "left" has a placeholder to fill
      t("left");
      // @ts-expect-error: not one of the app's strings
      t("nope");

      expectTypeOf(useQuery("list")).toEqualTypeOf<Item[]>();
      expectTypeOf(useQuery("inAisle", { aisle: "Dairy" })).toEqualTypeOf<Item[]>();
      useQuery("recent");
      useQuery("recent", { limit: 3 });
      // @ts-expect-error: this query needs its input
      useQuery("inAisle");
      // @ts-expect-error: this query takes none
      useQuery("list", { aisle: "Dairy" });
      // @ts-expect-error: a mutation is not read like a query
      useQuery("add");
      // @ts-expect-error: no such route
      useQuery("everything");

      const add = useMutation("add");
      expectTypeOf(add.run({ name: "Milk" })).toEqualTypeOf<Promise<Item>>();
      expectTypeOf(add.pending).toEqualTypeOf<boolean>();
      expectTypeOf(add.error).toEqualTypeOf<{ code: string } | null>();
      // @ts-expect-error: the name is missing
      void add.run({ aisle: "Dairy" });
      // @ts-expect-error: the input is missing
      void add.run();
      expectTypeOf(useMutation("clearTicked").run()).toEqualTypeOf<Promise<number>>();
      expectTypeOf(useMutation("touch").run()).toEqualTypeOf<Promise<void>>();
      // @ts-expect-error: a query is not called like a mutation
      useMutation("list");
      // @ts-expect-error: a job is neither read like a query
      useQuery("tidy");
      // @ts-expect-error: nor called like a mutation
      useMutation("tidy");

      const tidy = useJob("tidy");
      expectTypeOf(tidy).toEqualTypeOf<JobState>();
      expectTypeOf(tidy.succeededAt).toEqualTypeOf<string | null>();
      expectTypeOf(tidy.failedAt).toEqualTypeOf<string | null>();
      expectTypeOf(tidy.running).toEqualTypeOf<boolean>();
      expectTypeOf(tidy.canRun).toEqualTypeOf<boolean>();
      expectTypeOf(tidy.pending).toEqualTypeOf<boolean>();
      expectTypeOf(tidy.run()).toEqualTypeOf<Promise<void>>();
      // @ts-expect-error: a run takes nothing: it is the job's, as the scheduler starts it
      void tidy.run({ force: true });
      // @ts-expect-error: a job takes no input
      useJob("tidy", {});
      // @ts-expect-error: a query is no job
      useJob("list");
      // @ts-expect-error: nor is a mutation
      useJob("add");
      // @ts-expect-error: no such job
      useJob("nightly");
      return null;
    }
    expect(Widget).toBeTypeOf("function");
  });

  it("say nothing of why a run failed: what a person reads is the app's own, in their language", () => {
    expectTypeOf<keyof JobState>().toEqualTypeOf<"succeededAt" | "failedAt" | "running" | "canRun" | "run" | "pending">();
  });

  it("of an app without a server file have its strings and settings, and no routes to name", () => {
    const hooks = appHooks<typeof manifest>();
    expectTypeOf<QueryName<typeof manifest>>().toEqualTypeOf<never>();
    expectTypeOf<MutationName<typeof manifest>>().toEqualTypeOf<never>();
    expectTypeOf<JobName<typeof manifest>>().toEqualTypeOf<never>();
    function Widget() {
      const { t, settings } = hooks.useApp();
      // @ts-expect-error: an app without a server file has no query to read
      hooks.useQuery("list");
      // @ts-expect-error: and no mutation to call
      hooks.useMutation("add");
      // @ts-expect-error: and no job
      hooks.useJob("tidy");
      expectTypeOf(settings).toEqualTypeOf<{ aisles: string[]; hideDone: boolean }>();
      t("left", { count: 1 });
      // @ts-expect-error: not one of the app's strings
      t("nope");
      return null;
    }
    expect(Widget).toBeTypeOf("function");
  });

  it("are for an app, not for anything else", () => {
    // @ts-expect-error: the module of a server file is not its default export
    appHooks<{ default: Server }>();
    // @ts-expect-error: nor is a route by itself
    appHooks<Server["routes"]["list"]>();
    expect(appHooks<Server>()).toBe(appHooks<typeof manifest>());
    // One set of hooks serves every app: what tells them apart is only the type argument.
    expect(server.manifest).toBe(manifest);
  });
});

describe("an app's hooks at run time", () => {
  const items = [{ id: "1", name: "Milk" }];
  const run = vi.fn(async () => undefined);
  const runJob = vi.fn(async () => {});
  const job: JobState = {
    succeededAt: "2026-03-01T13:05:21.000Z",
    failedAt: null,
    running: true,
    canRun: false,
    run: runJob,
    pending: false,
  };
  const scope: AppScopeValue = {
    app: {
      t: (key, values) => `${key}:${JSON.stringify(values ?? {})}`,
      locale: "zh",
      user: { id: "u1", name: "Sam Example" },
      space: { kind: "group", name: "Family", members: [{ id: "u1", name: "Sam Example" }] },
      access: "view",
      canEdit: false,
      settings: { aisles: ["Dairy"], hideDone: true },
      pagePath: "/apps/s1/grocery",
    },
    useQuery: vi.fn((name: string, input: unknown) => (name === "list" && input === undefined ? items : [])),
    useMutation: vi.fn(() => ({ run, pending: false, error: { code: "forbidden" } })),
    useJob: vi.fn(() => job),
  };

  function Widget() {
    const { t, locale, user, space, canEdit, settings, pagePath } = useApp();
    const list = useQuery("list");
    const dairy = useQuery("inAisle", { aisle: "Dairy" });
    const add = useMutation("add");
    const tidy = useJob("tidy");
    return (
      <div>
        <p data-testid="app">
          {[t("left", { count: 2 }), locale, user.name, space.name, String(canEdit), settings.aisles.join(), pagePath].join(" | ")}
        </p>
        <p data-testid="data">{`${list.length} ${dairy.length} ${add.error?.code}`}</p>
        <p data-testid="job">{[tidy.succeededAt, String(tidy.failedAt), String(tidy.running), String(tidy.canRun)].join(" | ")}</p>
        <button type="button" onClick={() => void add.run({ name: "Eggs" })}>
          add
        </button>
        <button type="button" onClick={() => void tidy.run()}>
          tidy
        </button>
      </div>
    );
  }

  it("give a widget what the scope around it holds", () => {
    render(
      <AppScopeContext value={scope}>
        <Widget />
      </AppScopeContext>,
    );
    expect(screen.getByTestId("app").textContent).toBe('left:{"count":2} | zh | Sam Example | Family | false | Dairy | /apps/s1/grocery');
    expect(screen.getByTestId("data").textContent).toBe("1 0 forbidden");
    expect(scope.useQuery).toHaveBeenCalledWith("list", undefined);
    expect(scope.useQuery).toHaveBeenCalledWith("inAisle", { aisle: "Dairy" });
    expect(scope.useMutation).toHaveBeenCalledWith("add");
    expect(screen.getByTestId("job").textContent).toBe("2026-03-01T13:05:21.000Z | null | true | false");
    expect(scope.useJob).toHaveBeenCalledWith("tidy");

    screen.getByRole("button", { name: "add" }).click();
    expect(run).toHaveBeenCalledWith({ name: "Eggs" });
    screen.getByRole("button", { name: "tidy" }).click();
    expect(runJob).toHaveBeenCalledTimes(1);
  });

  it("say so when a widget is drawn where Hearth did not put it", () => {
    class Catch extends Component<{ children: ReactNode }, { message: string | null }> {
      override state = { message: null };
      static getDerivedStateFromError(error: Error) {
        return { message: error.message };
      }
      override render() {
        return this.state.message === null ? this.props.children : <p role="alert">{this.state.message}</p>;
      }
    }
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Catch>
        <Widget />
      </Catch>,
    );
    expect(screen.getByRole("alert").textContent).toMatch(/only work inside its widget or page/);
    quiet.mockRestore();
  });
});
