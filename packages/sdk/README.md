# @hearth/sdk

What a Hearth mini-app is written against. A mini-app imports this package and
nothing else: no framework internals, no other mini-app.

It is being built in steps; the design is
[docs/mini-app-contract.md](../../docs/mini-app-contract.md). So far it holds
the manifest, the UI kit and what an app's server file is written with.

## What is here

| Import | Holds | For |
|---|---|---|
| `@hearth/sdk` | `defineApp`, the manifest types (`Manifest`, `Setting`, `Localized`), `SettingsOf`, the message types (`MessageKey`, `PlaceholderArgs`, `Translate`), the lists `APP_ICONS` and `APP_COLORS`, `APP_ID_PATTERN`, `SDK_VERSION`. Imports nothing. | Mini-apps and the framework. |
| `@hearth/sdk/web` | The UI kit: `Button`, `IconButton`, `Input`, `Field`, `Switch`, `Checkbox`, `Chip`, `Tag`, `Segmented`, `Rows`, `Row`, `EmptyState`, `Dialog`, `DialogBody`, `Icon`, and the class helpers `buttonClass` and `chipClass`. | A mini-app's widget and page, and the shell. |
| `@hearth/sdk/server` | `defineServer`, `AppError`, `z` (the one zod that mini-apps use), and the types of a handler's context and of rows and collections (`QueryCtx`, `MutationCtx`, `Row`, `ReadCollection`, `Collection`, `Json`, `InputOf`, `OutputOf`). | A mini-app's `server.ts`. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, a zod schema that checks a manifest at run time. | The framework only. |

Still to come: the hooks in `@hearth/sdk/web`, `@hearth/sdk/testing`,
`@hearth/sdk/eslint` and the `hearth-apps` command.

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
  `name`), `access`, `settings` (typed from the manifest) and `now`. There is
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
  types (`InputOf`, `OutputOf`) for the hooks that will call them.

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
- Components take `className` to be placed in a layout; changing their look
  is the theme's job.

## Version

`SDK_VERSION` equals `version` in this package's `package.json`. A mini-apps
repository declares the version it was written for, and a build refuses a
mismatch (that check arrives with the build pipeline). While the version is
below 1.0, any breaking change to the SDK's types, to a kit component's props,
to a token class name or to the manifest schema raises the minor version.

## Commands

```sh
pnpm --filter @hearth/sdk typecheck   # also runs the type tests in src/index.test.ts and src/server.test.ts
pnpm --filter @hearth/sdk test        # the manifest in Node, the UI kit in a simulated browser
```

Only `src/web` may use the browser. It has its own `tsconfig.json` with the
DOM types; the rest of the package is checked without them.

To add an icon, add its name to `APP_ICONS` in `src/index.ts` and its Lucide
icon in `src/web/icon.tsx`. To add a component, export it from
`src/web/index.ts`: from then on its props are part of the version.
