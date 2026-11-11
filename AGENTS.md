# Hearth: notes for agents

Keep this file current. Update it in the same change whenever a fact below
stops being true.

## What this is

Hearth is a framework for personal mini-apps. One owner runs it on their own
server; later their family uses it too. This repository is the framework and
its SDK. It is public and licensed under AGPL-3.0.

Three repositories work together and are checked out side by side on the
server:

| Repository | Visibility | Holds |
|---|---|---|
| `hearth` (this one) | public | framework and SDK |
| `hearth-stones` | public | mini-apps, one folder each |
| `hearth-data` | private | the owner's content (notes as Markdown, later) |

The database file and secrets live in none of them.

## Rules that must not be broken

- **Nothing personal in this repository**, in files, commit messages or pull
  requests: no real domain, email address, server path, or real data. Use
  `example.com` and sample data only.
- **No secrets in Git.** Secrets come from a config file on the server.
- **A mini-app uses only the SDK**, never framework internals or another
  mini-app. This is enforced by an automated check.
- **Every row of data carries a space ID and the ID of the user who created
  it.** A space is either one person's personal space or a group space
  (family, team). Never write a query that is not scoped to a space.
- **Every interface string exists in English and Simplified Chinese.** Content
  typed by users is never translated.
- **Discuss before large changes.** The owner wants to agree on direction
  first, and reviews work through pull requests into `main`.

## Decisions already made

- TypeScript for frontend and backend; React single-page app built with Vite;
  a small Node server using Hono; SQLite; Tailwind CSS with shadcn/ui-style
  components.
- Visual direction "A · Clean": neutral blue-grey surfaces, white cards with a
  hairline border, one blue accent, and one icon colour per app.
- Access is handled by Cloudflare Access in front of the server. The app has
  no login page of its own; it verifies the signed identity header. "Who is
  this request from?" sits behind one small interface so another login method
  can be added later.
- Adding an app that already exists on the server to a space is a saved
  setting and needs no redeploy. A redeploy happens only when code changes.
- Deployment is pull-based: a timer on the server checks `main` in `hearth`
  and `hearth-stones`, builds, and switches over only if the build succeeds. No
  self-hosted GitHub Actions runner, because the repositories are public.
- On phones the tab bar is Home, Apps, Search, Me.

## Build order

1. App shell, deployed behind Cloudflare Access.
2. Mini-app contract, storage, settings and shared UI components.
3. Template and scaffold command.
4. Grocery list mini-app.
5. Scheduler, then the GitHub trending mini-app.

Items 2 to 4 follow `docs/mini-app-contract.md`: the agreed design (section
A), the owner's decisions at its top, and fifteen build steps (section B),
each marked there once built. Built so far: step 1, the SDK package skeleton;
step 2, the UI kit in the SDK; step 3, the shared contract and the database
tables for apps in spaces; step 4, the server's registry of apps and the
routes that add an app to a space, remove it, bring it back and delete its
data; step 5, `defineServer` in the SDK, the store behind `ctx.db` and the
routes that run an app's queries and mutations; step 6, an app's
settings: the two routes that read and save them, and `ctx.settings`;
step 7, the build pipeline: `hearth-apps sync` and `check`, the lists of
apps a build holds, the import scan and `@hearth/sdk/eslint`; and step 8,
widgets and pages in the shell: `appHooks`, `<AppScope>`, the dashboard's
cards and the app page.

## Layout and commands

| Folder | Holds |
|---|---|
| `packages/shared` | Types and schemas shared by server and web: the API contract. Change it first, then both sides. It already holds the requests and answers of routes that are not built yet (groups, members, access, moving an app). |
| `packages/sdk` | `@hearth/sdk`, what mini-apps are written against: `defineApp`, the manifest types, the lists of icon and colour names, `SDK_VERSION`. `@hearth/sdk/web` (`src/web`) is the UI kit, which the shell is built from too, and `appHooks` (`src/web/hooks.ts`), the hooks a widget or page is written with. `@hearth/sdk/web/scope` is the React context those hooks read, which the shell fills; for the framework only. `@hearth/sdk/server` (`src/server.ts`) is what an app's `server.ts` is written with: `defineServer`, `AppError`, `z` and the types of `ctx`; it holds no logic. `@hearth/sdk/manifest-schema` is the run-time check of a manifest and of a setting's value (`settingValueProblems`), for the framework only. `bin/hearth-apps.mjs` and `tools` are the `hearth-apps` command, plain JavaScript: `sync.mjs` (finds the apps, the version handshake, writes the generated lists), `import-scan.mjs` (what a file of an app may import), `default-export.mjs` (whether `widget.tsx`, `page.tsx` and `server.ts` have the default export the generated lists import), `check.mjs`, `eslint-boundary.mjs`. `@hearth/sdk/eslint` (`eslint.js`) and `tsconfig.app.json` are the ESLint and TypeScript configuration of a mini-apps repository. Imports no other Hearth package. |
| `packages/server` | Hono server: config, SQLite and migrations (`src/db`), identity, membership, `/api` routes, static files. `src/apps` is everything about mini-apps: `registry.ts` (the apps this build holds, checked at start-up), `definition.ts` (the check of an app's server file), `installs.ts` (who may use which app where; add, remove, bring back, delete data), `calls.ts` (runs one query or mutation: access check, input, `ctx`, handler, all in one transaction), `store.ts` (`ctx.db`, and the only SQL for `app_rows` and `app_settings`), `settings.ts` (an app's settings in a space: the two routes' work and what `ctx.settings` holds), `routes.ts`, `registry.generated.d.ts` (the types of the list of apps the build writes, which only `main.ts` imports) and `check-bundle.ts` (run by `hearth-apps check`, not by the server). `src/http` holds what routes share: `Refusal`, `readBody`, the security middleware. |
| `packages/fixture-apps` | The framework's own sample mini-apps, in the shape of a mini-apps repository. Tests run against them, and the end-to-end tests build with them. `checklist` has a manifest, a server file, a widget and a page; `feed` a manifest and a widget, no server file. |
| `packages/web` | React app: shell, pages, quick switcher, themes, `src/i18n` (English and Chinese), `src/styles` (the design tokens and the Tailwind theme). Its buttons, inputs, dialogs and so on come from `@hearth/sdk/web`; the card and the avatar in `src/components` are the shell's own. `src/apps` is everything about mini-apps in the browser: the list the build wrote (types in `registry.generated.d.ts`, imported by `main.tsx` only), `bundled.tsx` (the provider the shell reads it from), `api.ts` (the calls to an app's routes and settings), `scope.tsx` (`<AppScope>`: what `appHooks` reads, with fetching, polling and the session reload on `not_found`) and `app-view.tsx` (`<AppView>`: one app's widget or page with its skeleton, failed state, change notice and "Reload to update"). |
| `e2e` | Playwright end-to-end tests (`playwright.config.ts` at the root). |
| `deploy` | Pull-based deploy script, systemd units, polkit rule, example config. Not yet tested on a real server; `deploy/tests` runs the script against stand-ins for git, pnpm and systemctl. |
| `docs` | `architecture.md`, `self-hosting.md` and `mini-app-contract.md` (the agreed design for mini-apps and its build plan). |

Commands, from the repository root (Node 22, pnpm 10):

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Run server (port 4310) and web dev server (port 5173) with sign-in switched off. Add `HEARTH_APPS_DIR=packages/fixture-apps` to hold the sample apps, or the path of a mini-apps checkout. |
| `pnpm check` | Type checking (the packages, the fixture apps and `e2e`), lint, unit tests and the deploy script's tests. Run before every push. |
| `pnpm build` | Write the lists of mini-apps (`pnpm apps:sync`), then build shared, web and server. Without `HEARTH_APPS_DIR` the build holds no mini-apps. |
| `pnpm apps:sync` | `hearth-apps sync`: find the mini-apps in the folders named in `HEARTH_APPS_DIR`, check them, and write the three generated files. `pnpm build` and `pnpm dev` run it first. |
| `pnpm --filter @hearth/fixture-apps check` | `hearth-apps check` on the sample apps: sync, required files, manifests, types, lint. It leaves the generated files holding the sample apps. |
| `pnpm e2e` | End-to-end tests against the built app. Run `pnpm build` first. They build again with the sample apps, which stay in both `dist` folders until the next `pnpm build`. |
| `pnpm start` | Start the built server. |

Things that bite:

- TypeScript stays on version 6 until `typescript-eslint` supports 7.
- Every interface string goes in both `packages/web/src/i18n/en.ts` and
  `zh.ts`; a missing key is a type error.
- The server's Content-Security-Policy allows scripts from its own origin
  only: no inline scripts, no outside hosts, no outside fonts.
- With `HEARTH_AUTH=dev` the server answers only requests addressed to this
  machine (`localhost`, `127.0.0.1`, `::1`) and refuses any that a proxy or
  tunnel passed on. Reach it by one of those names, also in tests.
- Every email address goes through `normaliseEmail` in
  `packages/server/src/email.ts` before it is compared or stored.
- The deploy script stops the service for a moment at each switch to copy the
  database, and puts that copy back if the new release does not come up. A
  migration must therefore work on a copy of the real data in the trial start.
- Which mini-apps a server holds is decided when it is built, by
  `HEARTH_APPS_DIR` at that moment: one folder, or several separated like
  `PATH`, a relative one read from the root of this repository. The running
  server reads no apps folder. A plain `pnpm build` holds none, and so does
  a deployed release until the deploy script passes the variable (step 12).
- `hearth-apps sync` writes three files that are not in Git:
  `packages/server/src/apps/registry.generated.js`,
  `packages/web/src/apps/registry.generated.js` and
  `packages/web/src/apps/sources.generated.css`. Only `main.ts` and
  `main.tsx` import the lists; their types are the `registry.generated.d.ts`
  beside each, which is in Git. Type checking, lint and unit tests need
  none of the three, so `pnpm check` works on a fresh checkout. Building one
  package by itself does not: run `pnpm apps:sync` first, or `pnpm build`.
- The server's tests do not read the generated list. They pass
  `FIXTURE_APPS` (`packages/server/src/testing.ts`), written by hand; a test
  (`src/apps/fixtures.test.ts`) fails when it differs from the folders in
  `packages/fixture-apps`. Add a fixture app in both places.
- The dashboard draws a card for each app the session lists, and the card's
  inside from the build's list: an app the session lists and this build
  lacks gets "Reload to update". The shell draws the frame (icon, name,
  space tag, "Open"), the skeleton and the failed state; an app's widget
  and page have no loading or error code of their own. Groups cannot be
  created yet, so `canCreateGroups` and `canInvitePeople` in the session
  are always `false`; tests that need a group insert it with SQL
  (`src/apps/test-world.ts`).
- An app's `useQuery` suspends and is read again after any mutation of the
  same app in the same space that the server answered, saved or turned
  down, on window focus and every 15 seconds while the window is visible
  (`REFRESH_EVERY_MS` in `packages/web/src/apps/scope.tsx`); settings
  likewise. Any `not_found`
  from an app's routes reloads the session. Everything cached for one
  install starts with `installQueryKey`, so invalidating that key refreshes
  the whole app.
- `@hearth/sdk/web/scope` is for the framework: the import scan refuses it
  in a mini-app (only the exact names in `import-scan.mjs` are allowed).
  The hooks of `appHooks` are one shared object whatever the type argument,
  so they hold no logic; everything is in `<AppScope>`.
- `packages/sdk/tools` and `packages/sdk/bin` are plain JavaScript that Node
  runs before anything is built: no TypeScript syntax, and no import from
  `src`. They are type-checked through JSDoc (`allowJs` in the SDK's
  `tsconfig.json`). `APP_FOLDER_PATTERN` in `sync.mjs` repeats
  `APP_ID_PATTERN` for that reason; a test compares them.
- What a file of a mini-app may import is decided in one place,
  `scanApp` in `packages/sdk/tools/import-scan.mjs`. `hearth-apps sync` runs
  it before every build and the ESLint rule `hearth/mini-app-imports` runs
  the same function, so change the list there and nowhere else. A file's
  side follows from who imports it (`widget.tsx` and `page.tsx`,
  `server.ts`, `manifest.ts` on both); only imports that survive compiling
  count, and `import { type X }` survives. The scan skips `node_modules`
  and names that start with a dot, so it refuses an import that leads into
  either: one function, `isUnread`, says what is skipped and what is
  refused.
- `hearth-apps` ends with status 3 for exactly one thing: a folder of apps
  that declares another SDK version (`hearth.sdk` in its `package.json`)
  than `packages/sdk/package.json` has. The cross-repository CI job of step
  12 will read that status. Every other problem is status 1.
- A test that runs `hearth-apps` or `sync()` passes `--out` (or `out`) with
  a temporary folder, as `packages/sdk/tools/cli.test.ts` does. Without it
  the test rewrites this checkout's generated files. The mini-apps
  repositories those tests make up (`tools/test-repos.ts`) lie outside the
  checkout, linked to the SDK, as `hearth-stones` will.
- A mini-apps repository installs nothing but a link to the SDK, so what it
  needs to be checked is a dependency of `@hearth/sdk`: `typescript`,
  `eslint`, `@eslint/js`, `typescript-eslint`, `@types/react`.
  `packages/sdk/tsconfig.app.json` leads `react` to the SDK's copy of
  React's types for the same reason, and `resolve.dedupe` in
  `packages/web/vite.config.ts` gives an app the web app's React; without
  it a build with apps fails.
- A JSON config file may still name `HEARTH_APPS_DIR`; the server ignores
  it (`IGNORED_NAMES` in `packages/server/src/config.ts`), so that a file
  written for an earlier release does not fail the deploy's trial start.
- Who may use an app is decided in one place, the SQL named `VISIBLE` in
  `packages/server/src/apps/installs.ts`, which `resolveInstall` and the
  session both read. A route about one app answers 404 when `resolveInstall`
  gives `null`, whatever the reason, so that the reasons cannot be told apart.
  Do not add a second query that works out access.
- To turn a request down, throw `Refusal` (`packages/server/src/http/errors.ts`)
  from anywhere, also inside a transaction: the error handler answers with
  its status and code, and it is not logged. Its message reaches the client,
  so it must not say what the person may not know. Read a request body with
  `readBody` and its schema from `packages/shared`.
- A check and the change it allows go in one `db.transaction(...).immediate()`,
  as in `installs.ts`, so that a revoke cannot land between them.
- SQL that names `app_rows` or `app_settings` belongs in
  `packages/server/src/apps/store.ts` and in test files, nowhere else, and
  every statement there names its space and app. A test fails otherwise
  (`store-boundary.test.ts`); it reads source text, so a comment that names
  the tables in another file fails it too.
- A mini-app's handler never gets a database handle, a space ID or a user ID
  to pass on. `ctx.db` is built in `calls.ts` from the space and app of the
  address and the signed-in person, after `resolveInstall`, inside the same
  transaction (deferred for a query, immediate for a mutation). Keep it so
  when adding to `ctx` or to the store.
- Handlers are synchronous. One that returns a promise is answered with 500,
  and the store is closed when the handler returns, so that an `async`
  handler cannot write after the transaction. Do not add an `await` between
  the access check and the handler.
- What a handler does wrong has three kinds. `AppError` (from the SDK) is the
  request turned down: 400, 404 or 409, not logged. `StoreUsageError` is the
  app misusing the store, and `StoredRowError` a stored row that no longer
  fits its collection: both are logged inside an `AppFaultError` and answered
  with 500, like any other error a handler throws.
- Every query and mutation needs a `description`, one English sentence
  (owner's decision 7). The types require it and `checkServer`
  (`packages/server/src/apps/definition.ts`) refuses a server file without
  one at start-up, fixtures and test apps included.
- Settings are stored as values only, one JSON object for the space and
  one per person, and read against today's manifest in one place, `fill` in
  `packages/server/src/apps/settings.ts`, which the two routes and
  `ctx.settings` (`settingsFor`) share. A name the manifest does not
  declare under that scope is not read; a value that no longer fits reads
  as the default. Saving replaces the named values and must leave the rest
  of the stored object alone, so that a rolled-back release finds its
  values again. Never copy defaults into the database.
- Whether a value fits a setting is decided by `settingValueProblems` in
  `packages/sdk/src/manifest-schema.ts`, for a manifest's defaults and for
  what people save alike. A new setting type or limit goes there, into the
  types in `packages/sdk/src/index.ts` and into the schema beside it. A
  number's `step` limits values: `min` (or 0) plus a whole number of steps.
- Saving a setting of the space needs edit access; a person's own needs
  only view (owner's decision 5). The settings `PATCH` checks access, then
  names and values, then writes, in one immediate transaction, and saves a
  request as a whole or not at all.
- The store matches and sorts with SQL on the stored JSON but returns rows
  parsed by the collection's schema. The two agree because a row is stored
  as the schema's own output and a missing field counts as its default; a
  schema whose output it would not accept again is refused on insert.
- Removing an app from a space only sets `space_apps.removed_at`. Its rows,
  settings, switches and pins stay; bringing it back resets access
  (`member_access` as asked, exceptions deleted) and nothing else.
- `createApp` throws `AppRegistryError` for a bad manifest, an entry whose
  `id` differs from its manifest's, an ID that comes twice, or an entry
  that names `server` with nothing in it (a `server.ts` without a default
  export; the generated list names `server` exactly when the file exists).
  `main.ts` makes the same check before it opens the database and exits
  with status 1, which is what fails the deploy's trial start.
- A mini-app folder under `packages/fixture-apps` is held to the rules of
  every mini-app by `pnpm lint` (`miniAppBoundary` in
  `packages/sdk/tools/eslint-boundary.mjs`): the imports the scan allows,
  no `fetch`, `process`, `localStorage`, `eval` or `Function`, and no
  comment that switches a rule off. Server tests import a fixture's
  manifest and server file by relative path.
- A space may have several owners and must keep one. Triggers on
  `space_members` enforce it: insert the owner of a new space before anyone
  else, and expect `SQLITE_CONSTRAINT_TRIGGER` when the last owner is removed
  or demoted.
- Every table with `space_id` and `app_id` columns needs the composite
  foreign key to `space_apps` with `ON UPDATE CASCADE` (a test in
  `packages/server/src/db/apps-schema.test.ts` fails without it): moving an
  app is one `UPDATE` of `space_apps.space_id`. `app_rows` and `app_settings`
  are `ON DELETE RESTRICT` on purpose.
- Request schemas in `packages/shared` refuse unknown properties
  (`z.strictObject`); answers such as the session do not, so that a browser
  holding an older web app survives a newer server.
- A new required field in the session must also go into the sessions written
  by hand in `e2e/fixtures.ts`, `packages/web/src/session/api.test.ts` and
  `packages/web/src/components/switcher/quick-switcher.test.tsx`.
- The card sizes are listed in `@hearth/sdk` and again in `@hearth/shared`:
  the SDK imports no other Hearth package, and the API contract does not
  depend on the SDK. `packages/web/tests/contract.test.ts` fails when the
  lists differ.
- `SDK_VERSION` in `packages/sdk/src/index.ts` must equal `version` in
  `packages/sdk/package.json`; a unit test fails otherwise. Below 1.0, a
  breaking change to the SDK's types or to the manifest schema raises the
  minor version.
- The SDK's type tests (`expectTypeOf`, `@ts-expect-error` in
  `packages/sdk/src/index.test.ts` and `server.test.ts`) fail in
  `pnpm typecheck`, not in the test runner.
- A manifest has two descriptions that must agree: the types in
  `packages/sdk/src/index.ts` and the schema in `manifest-schema.ts`. Change
  both. `@hearth/sdk` itself must keep importing nothing (it ends up in the
  web bundle with every manifest); zod stays in `manifest-schema.ts` and
  `server.ts`.
- Icon and colour names are listed in the SDK. A new icon also needs its
  Lucide icon in `packages/sdk/src/web/icon.tsx` (a type error until then); a
  new colour needs a `--hearth-app-*` token in light and dark (the contrast
  test fails until then).
- What `packages/sdk/src/web/index.ts` exports is a promise to mini-apps in
  other repositories. Changing a component's props, removing one, or renaming
  a Tailwind token class in `packages/web/src/styles/index.css` is a breaking
  change to the SDK. Components only the shell needs stay in
  `packages/web/src/components`.
- The kit's components live in the SDK but their styles are built by the web
  app: `@source` in `packages/web/src/styles/index.css` makes Tailwind read
  `packages/sdk/src/web`. A class used in a file Tailwind does not read is
  silently missing from the stylesheet; unit tests do not notice, only the
  end-to-end tests and your eyes do.
- The SDK has two type-check projects, because only the kit may use the
  browser: `packages/sdk/tsconfig.json` (everything but `src/web`, no DOM
  types) and `packages/sdk/src/web/tsconfig.json`. Its unit tests likewise
  run as two vitest projects, Node and jsdom.
