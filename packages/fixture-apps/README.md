# Fixture apps

Mini-apps that belong to the framework: its tests run against them, and the
scaffold command will copy one as the template for a new app. This folder has
the shape of a mini-apps repository such as `hearth-stones`: a `package.json`
that says which SDK version the apps were written for, a `tsconfig.json`
that extends the SDK's, and one folder per app, named after the app's ID,
each using only `@hearth/sdk`.

They are sample apps with sample data. Nobody's real app lives here.

| Folder | Holds |
|---|---|
| `checklist` | A list of things to do. `manifest.ts`, `server.ts` (one collection, `items`, with a query that lists them and mutations that add one, tick one and clear the ticked ones), `widget.tsx` (the open items, each with a box to tick), `page.tsx` (every item by section, a form to add one, "Clear ticked") and `checklist.test.ts` (its own tests, written with `testApp` from `@hearth/sdk/testing`: two people sharing the list, view against edit, the settings). |
| `feed` | A card each person filters for themselves. `manifest.ts` with two settings of each person's own, and `widget.tsx`. It has no server file, so it keeps no rows, and its widget is typed from the manifest. |

Both get their strings, settings and data from the hooks of `appHooks` in
`@hearth/sdk/web`; the shell draws the card around a widget, the top bar
of a page, the loading and failed states.

## How they are used

- The server's unit tests pass them to `createApp({ apps })` by hand
  (`FIXTURE_APPS` in `packages/server/src/testing.ts`). A test fails when
  that list and these folders differ.
- The tests of the `hearth-apps` command (`packages/sdk/tools`) run `sync`,
  `check` and `test` on this folder, and on copies of these apps in a
  repository of their own outside the checkout.
- `pnpm test` at the repository's root runs the checklist's own tests, as
  `hearth-apps test` runs any mini-app's.
- The end-to-end tests build the framework with them
  (`HEARTH_APPS_DIR=packages/fixture-apps`, set in `playwright.config.ts`).
- A plain `pnpm build` or `pnpm dev` does not hold them. To run Hearth with
  them:

  ```sh
  HEARTH_APPS_DIR=packages/fixture-apps HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev
  ```

## Checks

`pnpm lint` at the repository's root holds every folder here to the rules
for a mini-app, `pnpm typecheck` checks them, and

```sh
pnpm --filter @hearth/fixture-apps check
pnpm --filter @hearth/fixture-apps test
```

run `hearth-apps check` and `hearth-apps test`, as a mini-apps repository
does. The check leaves the framework's generated lists holding these apps
until the next `pnpm build`; the tests write nothing.
