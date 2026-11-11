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
| `checklist` | A list of things to do. `manifest.ts`, `server.ts` (one collection, `items`, with a query that lists them and mutations that add one, tick one and clear the ticked ones) and `widget.tsx`. |
| `feed` | A card each person filters for themselves. `manifest.ts` with two settings of each person's own, and `widget.tsx`. It has no server file, so it keeps no rows. |

Both widgets are placeholders that draw the app's icon. A widget gets its
strings, its settings and its data from hooks, which arrive with the step of
[docs/mini-app-contract.md](../../docs/mini-app-contract.md) that draws
widgets in the shell.

## How they are used

- The server's unit tests pass them to `createApp({ apps })` by hand
  (`FIXTURE_APPS` in `packages/server/src/testing.ts`). A test fails when
  that list and these folders differ.
- The tests of the `hearth-apps` command (`packages/sdk/tools`) run `sync`
  and `check` on this folder, and on copies of these apps in a repository of
  their own outside the checkout.
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
```

runs `hearth-apps check`, as a mini-apps repository does. It leaves the
framework's generated lists holding these apps until the next `pnpm build`.
