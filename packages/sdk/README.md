# @hearth/sdk

What a Hearth mini-app is written against. A mini-app imports this package and
nothing else: no framework internals, no other mini-app.

It is being built in steps; the design is
[docs/mini-app-contract.md](../../docs/mini-app-contract.md). So far it holds
the manifest, the UI kit, the hooks a widget and a page are written with,
what an app's server file is written with, and the `hearth-apps` command that builds mini-apps into the framework and checks
them.

## What is here

| Import | Holds | For |
|---|---|---|
| `@hearth/sdk` | `defineApp`, the manifest types (`Manifest`, `Setting`, `Localized`), `SettingsOf`, the message types (`MessageKey`, `PlaceholderArgs`, `Translate`), the lists `APP_ICONS` and `APP_COLORS`, `APP_ID_PATTERN`, `SDK_VERSION`. Imports nothing. | Mini-apps and the framework. |
| `@hearth/sdk/web` | `appHooks`, which gives a widget or page `useApp`, `useQuery` and `useMutation`, and their types (`AppHooks`, `AppContext`, `MutationResult`, `QueryName`, `MutationName`, `InputArgs`, `Output`, `AppLike`). The UI kit: `Button`, `IconButton`, `Input`, `Field`, `Switch`, `Checkbox`, `Chip`, `Tag`, `Segmented`, `Rows`, `Row`, `EmptyState`, `Dialog`, `DialogBody`, `Icon`, and the class helpers `buttonClass` and `chipClass`. | A mini-app's widget and page; the kit also the shell. |
| `@hearth/sdk/server` | `defineServer`, `AppError`, `z` (the one zod that mini-apps use), and the types of a handler's context and of rows and collections (`QueryCtx`, `MutationCtx`, `Row`, `ReadCollection`, `Collection`, `Json`, `InputOf`, `OutputOf`). | A mini-app's `server.ts`. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, a zod schema that checks a manifest at run time, and `settingValueProblems`, which says whether a value fits a setting. | The framework only. |
| `@hearth/sdk/eslint` | The ESLint configuration of a mini-apps repository, and `miniAppBoundary`, the part of it that holds an app to the SDK. | A mini-apps repository's `eslint.config.js`. |
| `@hearth/sdk/tsconfig.app.json` | The compiler settings mini-apps are checked with. | A mini-apps repository's `tsconfig.json`. |
| `hearth-apps` (`bin/hearth-apps.mjs`, `tools/`) | The command: `sync` and `check`. | The framework's build, and a mini-apps repository checking itself. |

Still to come: `@hearth/sdk/testing`, and the commands `hearth-apps dev`,
`test` and `new`.

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
  between the two languages, and unknown properties.

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
- When any call answers that the app is not there (it was removed or moved
  to another space, or the person's access was taken away), the shell loads
  the session again and the card or page goes with the app.

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
package.json       "hearth": { "sdk": "^0.1.0" }, and @hearth/sdk as a link to ../hearth/packages/sdk
tsconfig.json      { "extends": "@hearth/sdk/tsconfig.app.json" }
eslint.config.js   export { default } from "@hearth/sdk/eslint";
grocery/
  manifest.ts      required: what makes the folder an app
  widget.tsx       required: the body of the app's card on the dashboard
  page.tsx         optional: the app's own page
  server.ts        optional: collections, queries and mutations
  package.json     required: the app's name; no dependencies
  README.md        required
```

The repository installs nothing but the link. The compiler, ESLint and
React's types come with the SDK.

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
`Function` alone, and cannot switch a lint rule off with a comment.

### The command

```sh
hearth-apps sync     # find the apps and tell the framework to build them in
hearth-apps check    # sync, then check every app
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
  `tsconfig.json`) and lint (ESLint with the folder's configuration).
  Without `HEARTH_APPS_DIR` it checks the folder it is run in. It does not
  run tests yet.
- Exit status: 0 when all is well; **3** when a folder of apps was written
  for another version of the SDK, and for nothing else; 1 for any other
  problem; 2 for a command it does not know.

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
