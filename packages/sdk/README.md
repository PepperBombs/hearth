# @hearth/sdk

What a Hearth mini-app is written against. A mini-app imports this package and
nothing else: no framework internals, no other mini-app.

It is being built in steps; the design is
[docs/mini-app-contract.md](../../docs/mini-app-contract.md). So far it holds
the manifest and the UI kit.

## What is here

| Import | Holds | For |
|---|---|---|
| `@hearth/sdk` | `defineApp`, the manifest types (`Manifest`, `Setting`, `Localized`), `SettingsOf`, the message types (`MessageKey`, `PlaceholderArgs`, `Translate`), the lists `APP_ICONS` and `APP_COLORS`, `APP_ID_PATTERN`, `SDK_VERSION`. Imports nothing. | Mini-apps and the framework. |
| `@hearth/sdk/web` | The UI kit: `Button`, `IconButton`, `Input`, `Field`, `Switch`, `Checkbox`, `Chip`, `Tag`, `Segmented`, `Rows`, `Row`, `EmptyState`, `Dialog`, `DialogBody`, `Icon`, and the class helpers `buttonClass` and `chipClass`. | A mini-app's widget and page, and the shell. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, a zod schema that checks a manifest at run time. | The framework only. |

Still to come: `@hearth/sdk/server`, the hooks in `@hearth/sdk/web`,
`@hearth/sdk/testing`, `@hearth/sdk/eslint` and the `hearth-apps` command.

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
pnpm --filter @hearth/sdk typecheck   # also runs the type tests in src/index.test.ts
pnpm --filter @hearth/sdk test        # the manifest in Node, the UI kit in a simulated browser
```

Only `src/web` may use the browser. It has its own `tsconfig.json` with the
DOM types; the rest of the package is checked without them.

To add an icon, add its name to `APP_ICONS` in `src/index.ts` and its Lucide
icon in `src/web/icon.tsx`. To add a component, export it from
`src/web/index.ts`: from then on its props are part of the version.
