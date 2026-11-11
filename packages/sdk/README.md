# @hearth/sdk

What a Hearth mini-app is written against. A mini-app imports this package and
nothing else: no framework internals, no other mini-app.

It is being built in steps; the design is
[docs/mini-app-contract.md](../../docs/mini-app-contract.md). So far it holds
the manifest.

## What is here

| Import | Holds | For |
|---|---|---|
| `@hearth/sdk` | `defineApp`, the manifest types (`Manifest`, `Setting`, `Localized`), `SettingsOf`, the message types (`MessageKey`, `PlaceholderArgs`, `Translate`), the lists `APP_ICONS` and `APP_COLORS`, `APP_ID_PATTERN`, `SDK_VERSION`. Imports nothing. | Mini-apps and the framework. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, a zod schema that checks a manifest at run time. | The framework only. |

Still to come: `@hearth/sdk/server`, `@hearth/sdk/web` (hooks and the UI
kit), `@hearth/sdk/testing`, `@hearth/sdk/eslint` and the `hearth-apps`
command.

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

## Version

`SDK_VERSION` equals `version` in this package's `package.json`. A mini-apps
repository declares the version it was written for, and a build refuses a
mismatch (that check arrives with the build pipeline). While the version is
below 1.0, any breaking change to the SDK's types or to the manifest schema
raises the minor version.

## Commands

```sh
pnpm --filter @hearth/sdk typecheck   # also runs the type tests in src/index.test.ts
pnpm --filter @hearth/sdk test
```
