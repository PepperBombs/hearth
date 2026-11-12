# @hearth/sdk

What a Hearth mini-app is written against. A mini-app imports this package and
nothing else: no framework internals, no other mini-app.

It is being built in steps; the design is
[docs/mini-app-contract.md](../../docs/mini-app-contract.md). So far it holds
the manifest, the UI kit, the hooks a widget and a page are written with,
what an app's server file and its tests are written with, and the
`hearth-apps` command that builds mini-apps into the framework, checks
them, runs their tests, runs Hearth with them and starts new ones.

## What is here

| Import | Holds | For |
|---|---|---|
| `@hearth/sdk` | `defineApp`, the manifest types (`Manifest`, `Setting`, `Localized`), `SettingsOf` and `SpaceSettingsOf`, the message types (`MessageKey`, `PlaceholderArgs`, `Translate`), the lists `APP_ICONS` and `APP_COLORS`, `APP_ID_PATTERN`, `SDK_VERSION`. Imports nothing. | Mini-apps and the framework. |
| `@hearth/sdk/web` | `appHooks`, which gives a widget or page `useApp`, `useQuery`, `useMutation` and `useJob`, and their types (`AppHooks`, `AppContext`, `MutationResult`, `JobState`, `QueryName`, `MutationName`, `JobName`, `InputArgs`, `Output`, `AppLike`). The UI kit: `Button`, `IconButton`, `Input`, `Field`, `Switch`, `Checkbox`, `Chip`, `Tag`, `Segmented`, `Rows`, `Row`, `EmptyState`, `Dialog`, `DialogBody`, `Icon`, and the class helpers `buttonClass` and `chipClass`. | A mini-app's widget and page; the kit also the shell. |
| `@hearth/sdk/server` | `defineServer`, `AppError`, `FetchError`, `z` (the one zod that mini-apps use), the types of a handler's context and of rows and collections (`QueryCtx`, `MutationCtx`, `Row`, `ReadCollection`, `Collection`, `Json`, `InputOf`, `OutputOf`), and those of a job (`JobAbout`, `Job`, `JobCtx`, `FetchInit`, `FetchResponse`, `FetchErrorCode`). | A mini-app's `server.ts`. |
| `@hearth/sdk/testing` | `testApp`, which puts an app in a space of a database of its own, calls its routes as people in it and runs its jobs with stand-ins for what they fetch, `AppCallError`, and their types (`TestApp`, `TestCaller`, `TestPerson`, `TestAppOptions`, `RunJobOptions`, `JobRun`, `StandInFetch`, `StandInRequest`, `StandInAnswer`). | A mini-app's tests (`*.test.ts`). |
| `@hearth/sdk/testing/host` | `provideTestApp`: how the framework hands `testApp` its implementation. | The framework only. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, a zod schema that checks a manifest at run time, and `settingValueProblems`, which says whether a value fits a setting. | The framework only. |
| `@hearth/sdk/eslint` | The ESLint configuration of a mini-apps repository, and `miniAppBoundary`, the part of it that holds an app to the SDK. | A mini-apps repository's `eslint.config.js`. |
| `@hearth/sdk/tsconfig.app.json` | The compiler settings mini-apps are checked with. | A mini-apps repository's `tsconfig.json`. |
| `hearth-apps` (`bin/hearth-apps.mjs`, `tools/`) | The command: `sync`, `check`, `test`, `dev` and `new`. | The framework's build, and a mini-apps repository checking, testing and running its apps and starting new ones. |

## A manifest

```ts
import { defineApp } from "@hearth/sdk";

export default defineApp({
  id: "grocery",
  name: { en: "Grocery list", zh: "购物清单" },
  description: { en: "A shared shopping list, grouped by aisle.", zh: "按货架分组的共享购物清单。" },
  icon: "shopping-bag",
  color: "green",
  widget: { size: "tall" },
  settings: {
    hideDone: {
      type: "switch", scope: "user", default: false,
      label: { en: "Hide ticked items", zh: "隐藏已勾选的物品" },
    },
  },
  messages: {
    en: { empty: "Nothing to buy.", left: "{count} left" },
    zh: { empty: "没有要买的东西。", left: "还剩 {count} 项" },
  },
});
```

- Every name, description, label, help text, option and message is written in
  English and Simplified Chinese. A message missing from `zh` is a type error.
- `SettingsOf<typeof manifest>` is the type of the settings values: here
  `{ hideDone: boolean }`. A `select` gives the union of its option keys.
- `Translate<typeof manifest>` is the type of `t`: `t("left", { count: 3 })`
  compiles, `t("left")` and `t("nope")` do not. Keep message strings in the
  manifest, or in a sibling file declared `as const`, so their placeholders
  are known.
- `manifestSchema` also refuses what the types cannot express: empty text, a
  default that does not fit its own setting (a `select` default that is not
  an option, a number outside `min` and `max`), placeholders that differ
  between the two languages, a host in `network` that is not a plain host
  name, and unknown properties.
- **`network`** lists the hosts the app's jobs may fetch from, exactly as
  the requests will name them: `network: ["api.github.com"]`. One to ten
  lower-case DNS names, none twice: no scheme, port, path, wildcard or IP
  address, and no name of the local network (`localhost`, `printer.local`,
  anything ending in `.localhost`, `.local`, `.internal` or `.home.arpa`).
  Whoever adds the app is told, in the dialog that adds it: "Fetches data
  from api.github.com on its own." Leave it out for an app that fetches
  nothing. Only a job fetches (see "Jobs" below), so an app that names
  hosts and defines no job does not start. It came with SDK 0.1.1, so a
  repository whose apps use it declares `"hearth": { "sdk": "^0.1.1" }`.

### Settings

A setting has a `scope`: `"space"` for one value shared by everyone in the
space, `"user"` for one value per person in that space. People change them
in a form the shell draws from the manifest; code reads them as
`ctx.settings`, typed by `SettingsOf`.

| Type | A value is | Limited by |
|---|---|---|
| `text` | text | `maxLength` |
| `number` | a finite number | `min`, `max`, `step` |
| `switch` | `true` or `false` | |
| `select` | the key of one option | `options` |
| `multi-select` | a list of option keys, none twice | `options` |
| `list` | a list of texts | `maxItems`, and `maxLength` for each text |

- The limits hold for the default and for every value someone saves; the
  server refuses a value that breaks them.
- `step` limits values as it does in a form's number field: a value is
  `min` (0 when there is none) plus a whole number of steps. `step: 1`
  means whole numbers. Leave it out to allow any number.
- Nothing is stored until someone saves a value, so a default may change
  with a release, and whoever has not saved one gets the new default.
- Settings may change with a release too. A value saved under a name the
  manifest no longer has is ignored. A saved value that no longer fits (an
  option that is gone, a shorter `maxLength`) reads as the default; a
  multi-select keeps the options that remain. Code therefore always gets a
  value its manifest allows.

## A server file

```ts
import { AppError, defineServer, z } from "@hearth/sdk/server";
import manifest from "./manifest";

const app = defineServer(manifest, {
  items: z.object({
    name: z.string().trim().min(1).max(80),
    aisle: z.string().max(40).default(""),
    done: z.boolean().default(false),
  }),
});

export default app.routes({
  list: app.query(
    { description: "Lists every item on the shopping list, oldest first." },
    (ctx) => ctx.db.items.list({ orderBy: "createdAt" }),
  ),
  add: app.mutation(
    {
      description: "Adds an item to the shopping list, optionally under an aisle.",
      input: z.object({ name: z.string(), aisle: z.string().default("") }),
    },
    (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
  ),
  rename: app.mutation(
    { description: "Gives one item of the shopping list another name.", input: z.object({ id: z.string(), name: z.string() }) },
    (ctx, { id, name }) => {
      if (ctx.db.items.count({ name }) > 0) throw new AppError("conflict", "That name is on the list already.");
      return ctx.db.items.update(id, { name });
    },
  ),
});
```

- **Collections** are zod object schemas. A row is checked when it is written
  and again when it is read, and comes back as `Row<T>`: its fields plus
  `id`, `createdBy`, `updatedBy`, `createdAt` and `updatedAt`, which the
  framework records. A field may not have one of those five names, and field
  names are letters, digits and underscores.
- There are no migrations. Give every field you add later a `.default()`:
  rows stored before it then read, match and sort as if they held the
  default. A stored row that no longer fits its schema fails the query.
- **A query** reads; its `ctx.db` has `get`, `list` and `count` only. **A
  mutation** changes data and also has `insert`, `update`, `remove` and
  `removeWhere`. The framework lets anyone who can see the app call a query,
  and only someone with edit access call a mutation.
- **Every route has a `description`**: one English sentence saying what it
  does, for a reader who has not seen the app. An assistant will later choose
  routes by it. A route without one stops the server from starting.
- **`input`** is a zod schema for what the caller sends; the handler gets
  its output. Leave it out for a route that takes nothing.
- **`ctx`** also has `user` (`id`, `name`), `locale`, `space` (`kind`,
  `name`), `access`, `settings` and `now`. `ctx.settings` is typed from the
  manifest and holds every setting by name: the space's value for a
  `"space"` setting, the caller's own for a `"user"` setting. There is
  no space ID and no database handle: `ctx.db` already reaches this app's
  rows in this space and no others.
- `list` takes `where` (fields and the text, number, switch or null each
  must equal), `mine` (only rows the caller created), `orderBy` (a field,
  `"createdAt"` or `"updatedAt"`), `desc` and `limit` (1000 unless given, at
  most 5000). `update` replaces the top-level fields it is given.
- **A handler is not `async`.** It runs inside one database transaction
  together with the check of who is asking; a handler that returns a promise
  is refused, and `ctx.db` stops working once the handler has returned. What
  a handler returns must survive JSON.
- To turn a request down, throw `AppError` with `"invalid_request"` (400),
  `"not_found"` (404) or `"conflict"` (409); what the mutation wrote so far
  is undone. A value that does not fit its collection's schema is refused as
  `invalid_request` by `insert` and `update` themselves, so an input schema
  need not repeat the collection's rules.
- `typeof server` (the default export) stands for the app in `SettingsOf`,
  `MessageKey` and `Translate`, and carries each route's input and output
  types (`InputOf`, `OutputOf`) for the hooks that call them.

### Jobs

A job is something the app does by itself, every so often, once for each
space it is in: fetching the latest headlines of a feed, say. It sits in
`app.routes` beside the queries and mutations, so the three share one set
of names, and every description is in one place.

```ts
const app = defineServer(manifest, {
  headlines: z.object({ title: z.string().min(1).max(200) }),
});

const feed = z.object({ items: z.array(z.object({ title: z.string() })) });

export default app.routes({
  latest: app.query(
    { description: "Lists the headlines the last refresh kept, in the feed's order." },
    (ctx) => ctx.db.headlines.list(),
  ),
  refresh: app.job(
    {
      description: "Fetches the sample news feed and keeps its first five headlines in place of those kept before.",
      everyMinutes: 60,
    },
    async (ctx) => {
      const answer = await ctx.fetch("https://feeds.example.com/headlines.json", { headers: { accept: "application/json" } });
      if (!answer.ok) throw new Error(`The feed answered ${answer.status}.`);
      const read = feed.safeParse(answer.json());
      if (!read.success) throw new Error("The feed's answer is not a list of headlines.");
      const titles = read.data.items.map((item) => item.title.trim().slice(0, 200)).filter((title) => title !== "");
      // Fetched first, then written in one go: no transaction waits on the network.
      ctx.write((db) => {
        db.headlines.removeWhere({});
        for (const title of titles.slice(0, 5)) db.headlines.insert({ title });
      });
    },
  ),
});
```

The manifest of this app lists `network: ["feeds.example.com"]`. It is a
shorter version of the framework's sample headlines
(`packages/fixture-apps/headlines` in the `hearth` checkout), whose widget,
tests and README are worth reading beside this section.

- **Every job has a `description`**, one English sentence, as a route
  has, and **`everyMinutes`**, how often it runs: a whole number from 15
  to 10080 (a week). It takes no input. The server does not start with a
  job that breaks one of these, and `hearth-apps check` says so first.
- **A job runs for the app in a space, for no one in it.** Its `ctx` has
  `space` (`kind`, `name`), `settings` (the space's settings, typed by
  `SpaceSettingsOf`: nobody's own), `now`, `fetch`, `read` and `write`,
  and no person, access level or language.
- **Its function may be `async`**, because it fetches. It reads and
  writes the app's rows only in `ctx.read((db) => ...)` and
  `ctx.write((db) => ...)`, each one transaction; `read` gives a `db` that
  cannot write, and `write` keeps all of its changes or none. Their `work`
  is not `async` and hands back no promise (a type error says so), so that
  no transaction waits on the network: fetch first, then write.
- **`ctx.fetch(url, { headers })`** GETs from a host the manifest lists in
  `network`, and gives the answer whole: `url`, `status`, `ok`, `headers`
  (names in lower case, without `set-cookie`), `text` and `json()`. A
  status that is not 2xx is an answer, not an error. When there is no
  answer it rejects with a `FetchError`, whose `code` says why: `refused`,
  `timeout`, `too_large`, `network` or `stopped`.
- **What `ctx.fetch` allows** is checked at every request:
  - an `https` address on the default port, without a user name or
    password, on a host the manifest lists exactly (`api.github.com` does
    not let in `github.com` or `x.api.github.com`); anything else is
    `refused` before it is sent;
  - `User-Agent: Hearth`, sent with every request, and of the job's own
    headers only `accept`, `accept-language`, `if-modified-since`,
    `if-none-match` and names starting with `x-` other than
    `x-forwarded-*` and `x-real-ip`, with values of plain ASCII; any other,
    such as `authorization` or `cookie`, is `refused`. No cookie is kept;
  - redirects, up to 3, while they stay on https and the same host; any
    other is `refused`;
  - 20 seconds for an answer, its body included (`timeout`), and 2 MiB of
    body, counted after decompression (`too_large`, and the download
    stops);
  - requests to one host start at least 6.5 seconds apart, across every
    app and space of the server: at most 10 a minute, GitHub's limit for
    searches without a token. A job that asks for 30 pages waits over
    three minutes for them, which counts against its run.
- A run went well when the function returned or its promise resolved;
  whatever it throws or rejects with makes it fail. A run has 5 minutes,
  then it is stopped and fails. After a failure the job runs again in 5
  minutes, then 10, 20, 40 ..., never later than its interval; after a run
  that went well, its interval to a tenth more after that run started.
  The message of what a failed run threw is kept with the job's status,
  on one line and at most 200 characters.
- **What a job writes** carries the ID of the person who added the app to
  the space, on whose behalf it runs, and the time of the write.
  `list({ mine: true })` throws in a job: a job is no one.
- **A run ends at once** when its time is up, when the server stops it,
  and when `ctx.read` or `ctx.write` finds that the app was removed from
  the space, moved to another or had its data deleted since the run
  started: they throw, and nothing is read or written. From then on
  `ctx.fetch` rejects with `stopped` and `ctx.read` and `ctx.write` throw,
  whatever the job does next. Work that hands back a promise makes the run
  fail, and what it did is undone. Work cannot call `ctx.read` or
  `ctx.write` itself: do it all in one.
- **A job is not a route.** `useQuery`, `useMutation` and a test's `query`
  and `mutation` cannot name it, only `useJob` can, and in a test `runJob`,
  `job` and `requestRun` (`JobName<typeof server>` names an app's jobs);
  the server answers 404 when one is asked for as a query or a mutation.
- **When it runs.** The server's scheduler runs a job in each space the
  app is in: the first time as soon as the app is added there, then about
  every `everyMinutes`, as above. It runs one job at a time on the whole
  server, every app and space together, so a job that takes long, or asks
  for many pages, puts the others off. A server with `HEARTH_JOBS=off`
  runs none. `pnpm dev` runs them, and `ctx.fetch` there reaches the real
  hosts the manifest names.
- **Someone with edit access may ask for a run now** ("Refresh now", with
  `useJob` in the widget, below). It starts at once, or 5 minutes after
  the last run started, never sooner, so asking again and again cannot
  hammer a host. Anyone who can see the app may read how the runs went.

## A widget and a page

```tsx
// widget.tsx
import { Checkbox, EmptyState, Row, Rows, appHooks } from "@hearth/sdk/web";
import type server from "./server";

const { useApp, useQuery, useMutation } = appHooks<typeof server>();

export default function Widget() {
  const { t, canEdit } = useApp();
  const open = useQuery("list").filter((item) => !item.done);
  const tick = useMutation("tick");
  if (open.length === 0) return <EmptyState title={t("empty")} />;
  return (
    <Rows>
      {open.slice(0, 6).map((item) => (
        <Row key={item.id}>
          <Checkbox checked={false} disabled={!canEdit || tick.pending} onChange={() => tick.run({ id: item.id, done: true })}>
            {item.name}
          </Checkbox>
        </Row>
      ))}
    </Rows>
  );
}
```

- **`widget.tsx`** is the body of the app's card on the dashboard and
  **`page.tsx`**, when there is one, the app's own page. Each has a default
  export, a React component that takes no props; `hearth-apps sync` refuses
  the file without one. The shell draws everything around them: the card's
  icon, name, the group's tag and the "Open" link, the page's top bar, a
  skeleton while the app loads, "This app could not be loaded" with a way to
  try again, and a notice under the app when a change was not saved. An app
  has no loading or error code of its own.
- **`appHooks<S>()`** is called once, at the top of the file, so that the
  hooks are plain names that begin with `use`. `S` is `typeof server`,
  imported with `import type` so that none of the server's code reaches the
  browser. An app without a server file passes `typeof manifest`; it then
  has no queries or mutations to name. From `S` follow the routes' names,
  what each takes and answers, the keys of `t` and the type of `settings`.
- **`useApp()`** gives `t` (the app's own strings in the reader's
  language, placeholders typed as in the manifest), `locale`, `user`
  (`id`, `name`), `space` (`kind`, `name`, and `members` with `id` and
  `name`; a personal space has an empty name), `access`, `canEdit`,
  `settings` (every setting by name: the space's value, the reader's own,
  or the default) and `pagePath`, the address of the app's page for a plain
  `<a href={pagePath}>`, or null without `page.tsx`. There is no space ID:
  the shell knows which app in which space it draws, and builds every
  address itself.
- **`useQuery(name, input)`** gives a query's answer. The component waits
  (suspends) until it is there. The answer is read again after every change
  this app makes here, whether the server saved it or turned it down, when
  the window is looked at again, and every 15 seconds while it is visible:
  that is how people in a space see each other's changes. Leave `input` out
  for a route that takes none, or whose schema accepts `undefined`.
- **`useMutation(name)`** gives `run(input)`, `pending` and `error`
  (`{ code }` or null). `run` resolves once the change is saved and the
  app's queries have been read again, so the screen already shows it. It
  rejects when the change was not made; the shell tells the person, so a
  caller that does not wait for it need not catch it. Disable what calls a
  mutation when `canEdit` is false: the server refuses it then.
- **`useJob(name)`** says how one of the app's jobs is doing in this
  space, for "Updated 12 min ago", a banner when the last run failed, and
  "Refresh now". It gives `succeededAt` (when the last run that went well
  ended: the data is from then; null before the first), `failedAt` (when
  the last run ended, if it went wrong; null otherwise), `running` (a run
  is going on, or was asked for and has not started: show
  "Refreshing…"), `canRun` (edit access), `run()` and `pending`. The
  times are ISO strings: read them with `new Date(...)`. The component
  waits (suspends) for the first status, as for a query. The status is
  read again with the queries, and every 3 seconds while `running`; once
  a run went well, every query of the app here is read again before the
  new status shows, so the screen never says "Updated just now" beside
  the old data. `run()` asks for a run and resolves once the server has
  the request (`running` is true by then), not when the run is done; it
  is refused and reported as a mutation is. Why a run failed is not
  given: the server keeps that message, in English, for its logs, and
  what a person reads comes from the app's own strings.

  ```tsx
  const { useApp, useJob } = appHooks<typeof server>();

  function Refresh() {
    const { t } = useApp();
    const refresh = useJob("refresh");
    return (
      <div>
        {refresh.failedAt !== null ? <p>{t("failed")}</p> : null}
        {refresh.canRun ? (
          <Button disabled={refresh.running || refresh.pending} onClick={() => void refresh.run()}>
            {refresh.running ? t("refreshing") : t("refresh")}
          </Button>
        ) : null}
      </div>
    );
  }
  ```

  The sample headlines' `widget.tsx` shows the whole of it: "Updated N
  min ago" and, after an hour and a half, the time of day, written with
  `Intl.DateTimeFormat` in the reader's language; the failed state with
  the time it failed and the time of what is shown ("Couldn't reach the
  feed at 14:05. Showing headlines from 13:05."); and a clock read again
  every 15 seconds, so that the minutes move on without anything being
  fetched.
- When any call answers that the app is not there (it was removed or moved
  to another space, or the person's access was taken away), the shell loads
  the session again and the card or page goes with the app.

## Tests of an app

```ts
// grocery/grocery.test.ts
import { testApp } from "@hearth/sdk/testing";
import { describe, expect, it } from "vitest";
import server from "./server";

describe("grocery", () => {
  it("shows what one person adds to everyone in the family", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin", access: "view" });

    const milk = sam.mutation("add", { name: "Milk" });
    expect(lin.query("list")).toMatchObject([{ name: "Milk", done: false, createdBy: sam.user.id }]);
    expect(() => lin.mutation("tick", { id: milk.id, done: true })).toThrow("forbidden");
  });
});
```

- **`testApp(server)`** takes what `server.ts` exports and puts the app in
  a space of a database of its own, empty and in memory: a group, unless the
  manifest allows only personal spaces (`testApp(server, { space:
  "personal" })` asks for one). Each call starts afresh. The app is checked
  first as the server checks it when it starts, so an app that would stop a
  deploy fails its tests too.
- **`as({ name, access, locale })`** is someone in that space: `name`
  (default "Sam") is who, and the same name is the same person, so their
  rows carry their `user.id` and `mine` finds them; `access` is "view" or
  "edit" (the default), kept by that caller; `locale` is what `ctx.locale`
  says (default "en"). A personal space has one person, who may always
  edit.
- **A caller** has `query(name, input)` and `mutation(name, input)`, typed
  from `typeof server` like the hooks, and `settings()` and
  `saveSettings(values)`, by name as `ctx.settings` has them. The answer is
  what the server would send a browser: the same check of who may do what
  and of the input, the same `ctx` and store in one transaction, the input
  and the answer passed through JSON. A setting of the space needs "edit"
  to save; a person's own needs "view".
- **A refusal throws `AppCallError`**, whose `code` is `invalid_request`,
  `forbidden`, `not_found` or `conflict` and whose message starts with it:
  `toThrow("forbidden")`. A handler that throws anything but `AppError`,
  returns a promise or returns what JSON cannot hold throws the error the
  server would log, and the test fails.
- A test file may import `vitest` and `@hearth/sdk/testing` besides what the
  app's other files may. Run the tests with `hearth-apps test` (`pnpm test`
  in a mini-apps repository): they run inside the framework, which supplies
  the store. `vitest` started by hand has none, and `testApp` says so.

### A job in a test

```ts
// headlines/headlines.test.ts
import { testApp, type StandInRequest } from "@hearth/sdk/testing";

it("keeps the feed's headlines, and keeps them when the feed fails", async () => {
  const app = testApp(server);
  const lin = app.as({ name: "Lin", access: "view" });
  const now = new Date("2026-03-01T08:00:00Z");
  const asked: StandInRequest[] = [];

  const run = await app.runJob("refresh", {
    now,
    fetch: (request) => {
      asked.push(request);
      return { body: { items: [{ title: "Rain tomorrow" }] } };
    },
  });
  expect(run).toEqual({ ok: true, error: null });
  expect(asked.map((request) => request.url)).toEqual(["https://feeds.example.com/headlines.json"]);
  expect(lin.query("latest")).toMatchObject([{ title: "Rain tomorrow" }]);
  expect(lin.job("refresh")).toEqual({ succeededAt: now.toISOString(), failedAt: null, running: false, canRun: false });

  expect(await app.runJob("refresh", { fetch: () => ({ status: 503 }) })).toEqual({ ok: false, error: "The feed answered 503." });
  expect(lin.query("latest")).toMatchObject([{ title: "Rain tomorrow" }]);
  expect(() => lin.requestRun("refresh")).toThrow("forbidden");
});
```

The sample headlines' own tests (`headlines.test.ts` there) are more of
the same: what a run asks for and keeps, a feed that fails or answers
something else, and a run asked for with view and with edit.

- **`app.runJob(name, { fetch, now })`** runs one of the app's jobs now, in
  the app's space, as the server's scheduler runs it: the same code claims,
  runs and records it, with the space's settings, the rules of
  `ctx.fetch` and the run's 5 minutes, whether the job is due or not. It
  resolves once the run is recorded, with `{ ok: true, error: null }` or
  `{ ok: false, error }`, the message of what made it fail. So a job that
  would fail on a server fails here: a host the manifest does not list, a
  header a job may not send, work that hands `ctx.write` a promise.
- **`fetch`** answers each request that passes the rules, in place of the
  network, at once and without the server's pace. It is given the address
  with its query and the headers sent (`user-agent: Hearth` among them),
  and answers `{ status, headers, body }`: status 200 unless given, a body
  sent as is when it is text and as JSON otherwise. Throwing fails the
  request as the network would (a `FetchError` of code `timeout` or
  `network` as itself), so keep what it is asked and check it after the
  run, as above, rather than calling `expect` inside it. Left out, every
  request fails as the network would. An answer that HTTP could not carry
  (a status outside 200 to 599, a body with 204, a header name with a
  space, a key other than the three) fails the test.
- **`now`** is when the run starts and ends: the job's `ctx.now`, the time
  its rows are written and the times its status keeps. Left out, it is the
  time of day.
- **A caller's `job(name)`** is the job's status as `useJob` shows it to
  that person: `succeededAt`, `failedAt`, `running` and `canRun`. Its
  **`requestRun(name)`** asks for a run as "Refresh now" does, which needs
  edit (`forbidden` otherwise), and gives the status afterwards, `running`
  then true. Nothing here starts the run asked for by itself: the test
  runs it with `runJob`, and `running` is false again once that run ends.
- A job never runs beside itself: `runJob` rejects while a run of the same
  job is going on, so await one before the next. In a personal space, name
  its person with `as(...)` before the first run: that adds the app there.

## The UI kit

```tsx
import { Checkbox, EmptyState, Icon, Row, Rows } from "@hearth/sdk/web";

<Rows>
  <Row>
    <Checkbox checked={item.done} disabled={!canEdit} onChange={(done) => tick(item.id, done)}>
      {item.name}
    </Checkbox>
  </Row>
</Rows>

<EmptyState icon={<Icon name="shopping-bag" size={20} />} title="Nothing to buy." />
```

- The shell is built from the same components, so a mini-app looks like the
  rest of Hearth without styling anything.
- The components are styled with Tailwind classes named after Hearth's design
  tokens (`bg-surface`, `text-fg-2`, `border-line`, `rounded-ctl`). The tokens
  and the stylesheet belong to the web app (`packages/web/src/styles`), whose
  build reads this folder for class names. A mini-app may use the same
  classes.
- `Icon` draws the icons named in `APP_ICONS`, the same names a manifest
  chooses from. It takes the colour of the text around it, or one of the app
  colours with `color`. Give it a `label` when it stands alone; without one
  it is hidden from screen readers.
- `Checkbox` wraps its text, so a press on the text ticks the box. It reports
  the new state and shows only the state it is given.
- Text in a `Checkbox` or a `Row` wraps, a long word or a pasted link
  included, so that what people type stays inside its card.
- Components take `className` to be placed in a layout; changing their look
  is the theme's job.

## A repository of mini-apps

Mini-apps live in a repository of their own, checked out beside `hearth`:
one folder per app, named after the app's ID. `hearth-stones` is one; the
framework's own sample apps in `packages/fixture-apps` have the same shape.

```
package.json       "hearth": { "sdk": "^0.1.0" }, @hearth/sdk as a link to ../hearth/packages/sdk,
                   and the scripts check, test, dev and new (hearth-apps check, test and new,
                   and exec hearth-apps dev)
pnpm-lock.yaml     the link, and nothing else
tsconfig.json      { "extends": "@hearth/sdk/tsconfig.app.json", "compilerOptions": { "noEmit": true } }
eslint.config.js   export { default } from "@hearth/sdk/eslint";
grocery/
  manifest.ts      required: what makes the folder an app
  widget.tsx       required: the body of the app's card on the dashboard
  page.tsx         optional: the app's own page
  server.ts        optional: collections, queries, mutations and jobs
  *.test.ts        optional: the app's tests
  package.json     required: the app's name; no dependencies
  README.md        required
```

The repository installs nothing but the link, so `pnpm install` there
downloads nothing, and the server's deploy runs it offline. The compiler,
ESLint, vitest and React's types come with the SDK. Leave out a
`packageManager` field: pnpm would first fetch the version it names, which
an offline install cannot.

### What a file of an app may import

| Import | Where |
|---|---|
| The app's own files, by a relative path that stays in its folder | Anywhere. |
| `@hearth/sdk` | Anywhere. |
| `@hearth/sdk/web`, `react` | `widget.tsx`, `page.tsx` and the files they import. |
| `@hearth/sdk/server` | `server.ts` and the files only it imports. |
| `./server`, with `import type` | The widget and the page: they see its types, never its code. |
| `vitest`, `@hearth/sdk/testing` | Test files (`*.test.ts`). |

Everything else is refused: other packages, Node's built-in modules, the
framework's packages, another app's files, `require`, an `import()` whose
address is not written out, and a file of the app's own that is hidden (a
name starting with a dot) or in a `node_modules` folder, because the check
does not read those. `manifest.ts` is read by the server and
the browser alike, so it and what it imports keep to `@hearth/sdk`. A file
both sides import may use neither side's part of the SDK. Write
`import type server from "./server"`, not `import { type ... }`: only the
first is removed entirely when the file is compiled.

A mini-app also leaves `fetch`, `process`, `localStorage`, `eval` and
`Function` alone, and cannot switch a lint rule off with a comment. It
fetches only in a job, with `ctx.fetch`, from the hosts its manifest lists.

### The command

```sh
hearth-apps sync       # find the apps and tell the framework to build them in
hearth-apps check      # sync, then check every app, its tests included
hearth-apps test       # the apps' tests
hearth-apps dev        # Hearth on this machine with the apps in
hearth-apps new <id>   # a new app in the folder <id>, copied from the sample checklist
```

- **`sync`** reads the folders named in `HEARTH_APPS_DIR` (several are
  separated like `PATH`; a relative one is read from the root of the
  `hearth` checkout). It checks the SDK version the folder declares, that
  the folder's `@hearth/sdk` is a link to this checkout, that no app ID
  comes twice, that `widget.tsx`, `page.tsx` and `server.ts` have their
  default export, that no app declares a dependency, and every import; then it
  writes the lists the framework's server and web app are built from. The
  framework runs it before every build and before `pnpm dev`. Without the
  variable there are no apps.
- **`check`** runs sync, then checks that every app has its `README.md` and
  `package.json`, that every manifest and server file is valid (the check
  the server makes when it starts), the types (`tsc` with the folder's
  `tsconfig.json`), lint (ESLint with the folder's configuration) and the
  apps' tests, as `test` runs them. Every part runs even when one before it
  failed. Without `HEARTH_APPS_DIR` it checks the folder it is run in.
- **`test`** makes sync's checks without writing anything, then runs the
  apps' test files (`.test.` and a JavaScript or TypeScript extension, not
  in hidden or `node_modules` folders) with the vitest of the framework's
  server package, which supplies `testApp` its store. The folders are
  chosen as for `check`.
- **`dev`** runs sync, then the framework's own `pnpm dev` with the apps in
  and sign-in switched off: the web app at http://localhost:5173, everyone
  signed in as `HEARTH_OWNER_EMAIL`, or `you@example.com` when that is not
  set. A change to a widget or a page shows without reloading the page; a
  change to a manifest or server file restarts the server. Start it again
  after adding or taking away an app, a page or a server file. The folders
  are chosen as for `check`. A stop signal it is sent goes to both servers,
  and they also stop when the process that started it ends. In a mini-apps
  repository the `dev` script is `exec hearth-apps dev`. `exec` puts the
  command in the place of the shell pnpm runs the script in, which would
  keep an interrupt sent to pnpm to itself and die of a terminate signal
  alone, so that a stop sent to `pnpm dev` alone reaches the servers.
  (pnpm's `shell-emulator` setting, which has no `exec`, cannot run that
  script.)
- **`new <id>`** makes a new app in a folder named `<id>`, as a copy of the
  framework's sample checklist (`packages/fixture-apps/checklist` in the
  `hearth` checkout): a complete app that passes `check` as it is, to be
  changed from there. The copy gets the new ID in its manifest, a test
  file named `<id>.test.ts`, a package name after the repository
  (`@hearth-stones/<id>`) and a README that says what to change first;
  everything else, the texts in both languages included, is the
  checklist's until its author changes it. The folder is chosen as for
  `check`, one only, and must be one sync takes apps from: the SDK version
  it declares and its link are checked first. It overwrites nothing: a
  name that is taken, by an app or by anything else, is refused, and
  nothing is written when anything is refused. In a mini-apps repository
  it is `pnpm new <id>`; a running `dev` sees the new app once started
  again.
- Exit status: 0 when all is well; **3** when a folder of apps was written
  for another version of the SDK, and for nothing else (`test`, `dev` and
  `new` included); 1 for any other problem, a failing test among them; 2
  for a command it does not know, or one given the wrong number of
  arguments.

Neither the scan nor lint is a sandbox. Mini-apps are trusted code; the
checks stop accidents.

## Version

`SDK_VERSION` equals `version` in this package's `package.json`. A mini-apps
repository declares the version it was written for as a caret range, and
`hearth-apps sync` refuses a build when this version does not fit it. While the version is
below 1.0, any breaking change to the SDK's types, to a kit component's props,
to a token class name or to the manifest schema raises the minor version.

A breaking change therefore goes out in two merges: raise the version here
and merge, then merge the matching change of the mini-apps. In between, the
server's deploy keeps the release it runs (status 3 stops the build, and
those commits are not built again), and CI's job that builds this
repository with `main` of `hearth-stones` passes with a notice. A change
that breaks the mini-apps without raising the version fails that job.

## Commands

```sh
pnpm --filter @hearth/sdk typecheck   # also runs the type tests in src/index.test.ts and src/server.test.ts
pnpm --filter @hearth/sdk test        # the manifest and the hearth-apps command in Node, the UI kit in a simulated browser
```

`bin` and `tools` are plain JavaScript, because the command runs before
anything is built. They are type-checked through their JSDoc comments. The
tests of the command (`tools/*.test.ts`) run it against the fixture apps and
against mini-apps repositories they make up in a temporary folder, and send
what it writes to a temporary folder as well.

Only `src/web` may use the browser. It has its own `tsconfig.json` with the
DOM types; the rest of the package is checked without them.

To add an icon, add its name to `APP_ICONS` in `src/index.ts` and its Lucide
icon in `src/web/icon.tsx`. To add a component, export it from
`src/web/index.ts`: from then on its props are part of the version.
