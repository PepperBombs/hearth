# @hearth/sdk

What the server and the web app share besides their API contract: the rules
every app's manifest keeps to, and Hearth's UI kit. It imports no other
Hearth package.

Every app in Hearth is made in Hearth ([docs/platform.md](../../docs/platform.md)):
a manifest and one HTML page, kept in the database and run in the browser's
sandbox. Mini-apps are no longer written against this package or built into
a release: version 0.2.0 removed what they were written with (`defineApp`,
the server side, the hooks of a widget and a page, the tests of an app) and
the `hearth-apps` command.

## What is here

| Import | Holds | Used by |
|---|---|---|
| `@hearth/sdk` | The manifest types (`Manifest`, `Setting`, `Localized`), the lists of allowed names with their types (`APP_ICONS`, `APP_COLORS`, `SPACE_KINDS`, `WIDGET_SIZES`, `SETTING_SCOPES`) and `APP_ID_PATTERN`. Imports nothing. | The server and the web app. |
| `@hearth/sdk/manifest-schema` | `manifestSchema`, the run-time check of a manifest, and `settingValueProblems`, which says whether a value fits a setting. | The server (`checkMadeManifest`, the settings routes) and the web app's settings form. |
| `@hearth/sdk/web` | The UI kit: `Button`, `IconButton`, `Input`, `Field`, `Switch`, `Checkbox`, `Chip`, `Tag`, `Segmented`, `Rows`, `Row`, `EmptyState`, `Dialog`, `DialogBody`, `Icon`, and the class helpers `buttonClass` and `chipClass`. | The web app's shell. |

## A manifest

An app made in Hearth has a manifest of its own shape
(`packages/server/src/made/manifest.ts`). The server works out this one from
it (`asSdkManifest`) and checks it with `manifestSchema`
(`checkMadeManifest`), so that the app's settings and hosts follow exactly
the rules below, and Hearth's settings dialog and settings routes serve it
like any app.

```ts
import type { Manifest } from "@hearth/sdk";

const manifest: Manifest = {
  id: "m-k3x9p2q7ab",
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
};
```

- Every name, description, label, help text and option is written in
  English and Simplified Chinese.
- `manifestSchema` also refuses what the types cannot express: empty text, a
  default that does not fit its own setting (a `select` default that is not
  an option, a number outside `min` and `max`), placeholders that differ
  between the two languages, a host in `network` that is not a plain host
  name, and unknown properties.
- **`network`** lists the hosts the app may fetch from, through the server,
  exactly as the requests will name them: `network: ["api.github.com"]`.
  One to ten lower-case DNS names, none twice: no scheme, port, path,
  wildcard or IP address, and no name of the local network (`localhost`,
  `printer.local`, anything ending in `.localhost`, `.local`, `.internal` or
  `.home.arpa`). Whoever adds the app is told, in the dialog that adds it.
  Leave it out for an app that fetches nothing; only a built-in app names
  hosts (docs/platform.md).
- `spaces` (the kinds of space an app is for) and `messages` (interface
  strings with {placeholders}) are still checked, but an app made in Hearth
  leaves both out: it lives in the space it was made in, and its page holds
  its own texts.

### Settings

A setting has a `scope`: `"space"` for one value shared by everyone in the
space, `"user"` for one value per person in that space. People change them
in a form the shell draws from the manifest; an app's page reads them with
`hearth.settings()`.

| Type | A value is | Limited by |
|---|---|---|
| `text` | text | `maxLength` |
| `number` | a finite number | `min`, `max`, `step` |
| `switch` | `true` or `false` | |
| `select` | the key of one option | `options` |
| `multi-select` | a list of option keys, none twice | `options` |
| `list` | a list of texts | `maxItems`, and `maxLength` for each text |

- The limits hold for the default and for every value someone saves; the
  server refuses a value that breaks them (`settingValueProblems`).
- `step` limits values as it does in a form's number field: a value is
  `min` (0 when there is none) plus a whole number of steps. `step: 1`
  means whole numbers. Leave it out to allow any number.
- Nothing is stored until someone saves a value, so a default may change
  with the app, and whoever has not saved one gets the new default.
- Settings may change with the app too. A value saved under a name the
  manifest no longer has is ignored. A saved value that no longer fits (an
  option that is gone, a shorter `maxLength`) reads as the default; a
  multi-select keeps the options that remain. The page therefore always
  gets a value its manifest allows.

## The UI kit

```tsx
import { Checkbox, EmptyState, Icon, Row, Rows } from "@hearth/sdk/web";

<Rows>
  <Row>
    <Checkbox checked={done} onChange={setDone}>
      Show my own apps first
    </Checkbox>
  </Row>
</Rows>

<EmptyState icon={<Icon name="shopping-bag" size={20} />} title="No apps here yet." />
```

- The shell is built from these components. An app made in Hearth does not
  use them: its page runs in the sandbox, apart from the shell, with
  Hearth's colours given to it by the server.
- The components are styled with Tailwind classes named after Hearth's design
  tokens (`bg-surface`, `text-fg-2`, `border-line`, `rounded-ctl`). The tokens
  and the stylesheet belong to the web app (`packages/web/src/styles`), whose
  build reads this folder for class names.
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

## Version

The version is `version` in this package's `package.json`. Nothing outside
this repository uses the package any more and no build compares versions,
so it only records what changed: while it is below 1.0, a breaking change
to the types, to a kit component's props, to a token class name or to the
manifest schema raises the minor version, and an addition the patch
version. 0.2.0 removed everything mini-apps were written with.

## Commands

```sh
pnpm --filter @hearth/sdk typecheck   # also runs the type tests in src/index.test.ts and src/manifest-schema.test.ts
pnpm --filter @hearth/sdk test        # the manifest and its schema in Node, the UI kit in a simulated browser
```

Only `src/web` may use the browser. It has its own `tsconfig.json` with the
DOM types; the rest of the package is checked without them.

To add an icon, add its name to `APP_ICONS` in `src/index.ts` and its Lucide
icon in `src/web/icon.tsx`. A new colour needs a `--hearth-app-*` token in
the web app's styles, in light and dark. To add a component, export it from
`src/web/index.ts`.
