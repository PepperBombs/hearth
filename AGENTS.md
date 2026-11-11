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
data; and step 5, `defineServer` in the SDK, the store behind `ctx.db` and
the routes that run an app's queries and mutations.

## Layout and commands

| Folder | Holds |
|---|---|
| `packages/shared` | Types and schemas shared by server and web: the API contract. Change it first, then both sides. It already holds the requests and answers of routes that are not built yet (groups, members, access, moving an app, app settings). |
| `packages/sdk` | `@hearth/sdk`, what mini-apps are written against: `defineApp`, the manifest types, the lists of icon and colour names, `SDK_VERSION`. `@hearth/sdk/web` (`src/web`) is the UI kit, which the shell is built from too. `@hearth/sdk/server` (`src/server.ts`) is what an app's `server.ts` is written with: `defineServer`, `AppError`, `z` and the types of `ctx`; it holds no logic. `@hearth/sdk/manifest-schema` is the run-time check of a manifest, for the framework only. Imports no other Hearth package. |
| `packages/server` | Hono server: config, SQLite and migrations (`src/db`), identity, membership, `/api` routes, static files. `src/apps` is everything about mini-apps: `registry.ts` (the apps this build holds, checked at start-up), `definition.ts` (the check of an app's server file), `installs.ts` (who may use which app where; add, remove, bring back, delete data), `calls.ts` (runs one query or mutation: access check, input, `ctx`, handler, all in one transaction), `store.ts` (`ctx.db`, and the only SQL for `app_rows` and `app_settings`), `settings.ts` (what `ctx.settings` holds) and `routes.ts`. `src/http` holds what routes share: `Refusal`, `readBody`, the security middleware. |
| `packages/fixture-apps` | The framework's own sample mini-apps, in the shape of a mini-apps repository. Tests run against them. So far `checklist`, a manifest and a server file. |
| `packages/web` | React app: shell, pages, quick switcher, themes, `src/i18n` (English and Chinese), `src/styles` (the design tokens and the Tailwind theme). Its buttons, inputs, dialogs and so on come from `@hearth/sdk/web`; the card and the avatar in `src/components` are the shell's own. |
| `e2e` | Playwright end-to-end tests (`playwright.config.ts` at the root). |
| `deploy` | Pull-based deploy script, systemd units, polkit rule, example config. Not yet tested on a real server; `deploy/tests` runs the script against stand-ins for git, pnpm and systemctl. |
| `docs` | `architecture.md`, `self-hosting.md` and `mini-app-contract.md` (the agreed design for mini-apps and its build plan). |

Commands, from the repository root (Node 22, pnpm 10):

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Run server (port 4310) and web dev server (port 5173) with sign-in switched off. |
| `pnpm check` | Type checking (the packages, the fixture apps and `e2e`), lint, unit tests and the deploy script's tests. Run before every push. |
| `pnpm build` | Build shared, web, then server. |
| `pnpm e2e` | End-to-end tests against the built app. Run `pnpm build` first. |
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
- A running server holds no mini-apps yet: `main.ts` passes `createApp` an
  empty list until the build writes one (step 7). Its session lists no apps
  and pages show empty states. Only the server's tests pass apps in
  (`FIXTURE_APPS` in `packages/server/src/testing.ts`). The web app knows
  nothing of manifests yet. Groups cannot be created yet either, so
  `canCreateGroups` and `canInvitePeople` in the session are always `false`;
  tests that need a group insert it with SQL (`src/apps/test-world.ts`).
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
- `ctx.settings` is the manifest's defaults for now: `settingsFor` in
  `packages/server/src/apps/settings.ts` is the one place it comes from, and
  step 6 fills it from the saved values.
- The store matches and sorts with SQL on the stored JSON but returns rows
  parsed by the collection's schema. The two agree because a row is stored
  as the schema's own output and a missing field counts as its default; a
  schema whose output it would not accept again is refused on insert.
- Removing an app from a space only sets `space_apps.removed_at`. Its rows,
  settings, switches and pins stay; bringing it back resets access
  (`member_access` as asked, exceptions deleted) and nothing else.
- `createApp` throws `AppRegistryError` for a bad manifest, an entry whose
  `id` differs from its manifest's, or an ID that comes twice. `main.ts`
  makes the same check before it opens the database and exits with status 1,
  which is what fails the deploy's trial start.
- A mini-app folder under `packages/fixture-apps` may import `@hearth/sdk`
  and its own files only; `pnpm lint` enforces it
  (`hearth/mini-app-imports`). Server tests import a fixture's manifest by
  relative path.
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
