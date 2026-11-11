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
apps a build holds, the import scan and `@hearth/sdk/eslint`; step 8,
widgets and pages in the shell: `appHooks`, `<AppScope>`, the dashboard's
cards and the app page; step 9, the Apps page (add, remove, each
person's switch and pin, and the route behind them) and the settings dialog
drawn from a manifest; step 10, groups, members and access: creating
and renaming a group, adding, inviting, changing and removing people,
invitations turned into membership on arrival, the policy of who may create
groups and invite, the owners' list, the access route, and a card for each
group in Settings with the member-by-app table; step 11, moving an app
with its data to another space: the route and the dialog on the Apps page;
step 12, deploy and CI: the deploy links the mini-apps to the SDK of
their release, offline, and builds them in, keeping the running release when
they were written for another SDK version, and CI builds every change with
`main` of `hearth-stones`; and step 13, the setup of `hearth-stones` (its
`package.json` with the link to the SDK, lockfile, `tsconfig.json`,
`eslint.config.js` and CI), `@hearth/sdk/testing` with `testApp`, which
runs an app's own tests against the real store, and the commands
`hearth-apps test` and `hearth-apps dev`.

## Layout and commands

| Folder | Holds |
|---|---|
| `packages/shared` | Types and schemas shared by server and web: the API contract. Change it first, then both sides. Every route of the mini-app contract's section A8 is built. |
| `packages/sdk` | `@hearth/sdk`, what mini-apps are written against: `defineApp`, the manifest types, the lists of icon and colour names, `SDK_VERSION`. `@hearth/sdk/web` (`src/web`) is the UI kit, which the shell is built from too, and `appHooks` (`src/web/hooks.ts`), the hooks a widget or page is written with. `@hearth/sdk/web/scope` is the React context those hooks read, which the shell fills; for the framework only. `@hearth/sdk/server` (`src/server.ts`) is what an app's `server.ts` is written with: `defineServer`, `AppError`, `z` and the types of `ctx`; it holds no logic. `@hearth/sdk/testing` (`src/testing.ts`) is what an app's tests are written with: `testApp`, `AppCallError` and their types; it holds no logic, only the hand-over to what the framework installs through `@hearth/sdk/testing/host` (`src/testing-host.ts`, for the framework only). `src/routes.ts` holds the types that name an app's routes, shared by the hooks and the tests and exported from `@hearth/sdk/web`. `@hearth/sdk/manifest-schema` is the run-time check of a manifest and of a setting's value (`settingValueProblems`), for the framework only. `bin/hearth-apps.mjs` and `tools` are the `hearth-apps` command, plain JavaScript: `sync.mjs` (finds the apps, the version handshake, writes the generated lists), `import-scan.mjs` (what a file of an app may import), `default-export.mjs` (whether `widget.tsx`, `page.tsx` and `server.ts` have the default export the generated lists import), `check.mjs`, `test.mjs` (runs the apps' tests), `dev.mjs` (the dev servers with the apps in), `eslint-boundary.mjs`. `@hearth/sdk/eslint` (`eslint.js`) and `tsconfig.app.json` are the ESLint and TypeScript configuration of a mini-apps repository. Imports no other Hearth package. |
| `packages/server` | Hono server: config, SQLite and migrations (`src/db`), identity, membership, `/api` routes, static files. `src/apps` is everything about mini-apps: `registry.ts` (the apps this build holds, checked at start-up), `definition.ts` (the check of an app's server file), `installs.ts` (who may use which app where; add, remove, bring back, move to another space, delete data, each person's switch and pin), `calls.ts` (runs one query or mutation: access check, input, `ctx`, handler, all in one transaction), `store.ts` (`ctx.db`, and the only SQL for `app_rows` and `app_settings`), `settings.ts` (an app's settings in a space: the two routes' work and what `ctx.settings` holds), `routes.ts`, `registry.generated.d.ts` (the types of the list of apps the build writes, which only `main.ts` imports), `check-bundle.ts` (run by `hearth-apps check`, not by the server), and `app-testing.ts` with `app-testing.setup.ts` (the implementation of `testApp` for an app's own tests, which `vitest.apps.config.ts` at the package's root installs; not part of the server). `installs.ts` also holds the owners' list of a space's apps (`listSpaceApps`) and the access route's work (`setAppAccess`). `src/groups` is groups and their people: `policy.ts` (`groupRights`: who may create groups and invite), `members.ts` (create, rename, add or invite, change, remove or leave, take an invitation back) and `routes.ts`. `src/http` holds what routes share: `Refusal`, `readBody`, the security middleware. |
| `packages/fixture-apps` | The framework's own sample mini-apps, in the shape of a mini-apps repository. Tests run against them, and the end-to-end tests build with them. `checklist` has a manifest, a server file, a widget, a page and tests of its own (`checklist.test.ts`, written with `testApp`); `feed` a manifest and a widget, no server file. |
| `packages/web` | React app: shell, pages, quick switcher, themes, `src/i18n` (English and Chinese), `src/styles` (the design tokens and the Tailwind theme). Its buttons, inputs, dialogs and so on come from `@hearth/sdk/web`; the card, the avatar and `LinkedText` in `src/components` are the shell's own. `src/apps` is everything about mini-apps in the browser: the list the build wrote (types in `registry.generated.d.ts`, imported by `main.tsx` only), `bundled.tsx` (the provider the shell reads it from), `api.ts` (the calls to an app's routes and settings, and adding, removing, moving, switch and pin), `scope.tsx` (`<AppScope>`: what `appHooks` reads, with fetching, polling and the session reload on `not_found`), `app-view.tsx` (`<AppView>`: one app's widget or page with its skeleton, failed state, change notice and "Reload to update"), `manage.tsx` (adding, removing, moving, switch and pin, and the settings button) and `settings-dialog.tsx` (the settings form drawn from a manifest). `src/pages/apps.tsx` is the Apps page, with the dialogs that add, move and remove an app. `src/groups` is the groups' cards in Settings: `groups.tsx` (the cards, creating, renaming, leaving), `people.tsx` (the people, adding, the dialog for one person, invitations), `access-table.tsx` (the member-by-app table), `api.ts` and `queries.ts`. |
| `e2e` | Playwright end-to-end tests (`playwright.config.ts` at the root). |
| `deploy` | Pull-based deploy script, systemd units, polkit rule, example config. Each release is built with the mini-apps of `APPS_REPO` at the same moment, copied in beside the framework and linked to its SDK. Not yet tested on a real server; `deploy/tests` runs the script against stand-ins for git, pnpm and systemctl. |
| `.github/workflows` | `ci.yml`: the framework by itself (`check`), end to end with the sample apps (`e2e`), and with `main` of `hearth-stones` checked out beside it (`mini-apps`). |
| `docs` | `architecture.md`, `self-hosting.md` and `mini-app-contract.md` (the agreed design for mini-apps and its build plan). |

Commands, from the repository root (Node 22, pnpm 10):

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Run server (port 4310) and web dev server (port 5173) with sign-in switched off. Add `HEARTH_APPS_DIR=packages/fixture-apps` to hold the sample apps, or the path of a mini-apps checkout. |
| `pnpm check` | Type checking (the packages, the fixture apps and `e2e`), lint, unit tests (the fixture apps' own tests too) and the deploy script's tests. Run before every push. |
| `pnpm build` | Write the lists of mini-apps (`pnpm apps:sync`), then build shared, web and server. Without `HEARTH_APPS_DIR` the build holds no mini-apps. |
| `pnpm apps:sync` | `hearth-apps sync`: find the mini-apps in the folders named in `HEARTH_APPS_DIR`, check them, and write the three generated files. `pnpm build` and `pnpm dev` run it first. |
| `pnpm --filter @hearth/fixture-apps check` | `hearth-apps check` on the sample apps: sync, required files, manifests, types, lint, tests. It leaves the generated files holding the sample apps. |
| `pnpm --filter @hearth/fixture-apps test` | `hearth-apps test` on the sample apps: their own tests, inside `packages/server`. |
| `HEARTH_APPS_DIR=../hearth-stones node packages/sdk/bin/hearth-apps.mjs dev` | `hearth-apps dev`: sync, then `pnpm dev` with those apps and sign-in switched off. In a mini-apps repository it is `pnpm dev` there. |
| `pnpm e2e` | End-to-end tests against the built app. Run `pnpm build` first. They build again with the sample apps, which stay in both `dist` folders until the next `pnpm build`. |
| `pnpm start` | Start the built server. |

Things that bite:

- TypeScript stays on version 6 until `typescript-eslint` supports 7.
- Every interface string goes in both `packages/web/src/i18n/en.ts` and
  `zh.ts`; a missing key is a type error. Words in [brackets] name a page
  and are drawn as a link to it by `LinkedText`
  (`packages/web/src/components/linked-text.tsx`), wherever they fall in
  each language; an i18n test checks that both languages mark the same
  link. A string with brackets must be drawn with `LinkedText`.
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
  server reads no apps folder. A plain `pnpm build` holds none. The deploy
  script passes the release's own copy of the mini-apps
  (`releases/<time>/hearth-stones`, from `APPS_REPO`), after linking it to
  the release's SDK with `pnpm install --frozen-lockfile --offline`; it logs
  what the build holds from sync's line "this build holds ...".
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
  space tag, the settings button, "Open"), the skeleton and the failed state; an app's widget
  and page have no loading or error code of their own. Server tests that
  need a group mostly insert it with SQL (`family()` in
  `src/apps/test-world.ts`); `src/groups/routes.test.ts` makes them
  through the routes.
- Every list of apps on screen comes from `enabledApps` (switched on,
  pinned first) or, on the Apps page alone, from all of `session.apps`, in
  `packages/web/src/session/session.ts`. A switch or pin is
  `PATCH .../apps/:appId/me`, the caller's own row in `app_prefs`; the page
  shows it before the server answers and then loads the session again.
- Adding, removing and moving an app, and every change to a group, load
  the session (and the owners' list) again whatever the server answered: a
  refusal usually means the page was out of date. That reload can take a
  dialog away before its mutation settles, and TanStack Query then skips
  the callbacks given to that one `mutate` call. A dialog whose open state
  is kept by something the reload leaves on the page must not count on
  them to close it: close it with `mutateAsync(...).then(...)`, and clear
  that state while rendering once the page no longer shows what the dialog
  is about, as `People` and `AddApp` do; otherwise it opens by itself when
  that comes back.
- For an owner, the dialog that adds an app reads the owners' list
  (`useSpaceApps`, also for a personal space) and adds nothing until it has
  it, so that an app the space removed is shown as coming back with its
  data ("Bring back"). A member who may add apps reads no owners' list.
- The settings dialog sends only the values the person changed, compared
  with what was saved when it opened: a saved value stays saved even when it
  equals today's default. It checks values with `settingValueProblems`
  first, and shares its cached settings with `<AppScope>` (`settingsQuery`).
  A new setting type needs a control in `settings-dialog.tsx` too.
- Removing an app keeps everyone's switches, pins and settings, and the
  end-to-end tests against the real server share one server. A test there
  that changes them puts them back before it removes the app, as
  `e2e/real-server.spec.ts` does. Removing also keeps the app's data, and a
  space that kept an app's data cannot take that app by a move: the move
  test there deletes what earlier tests left in the owner's personal space
  (`DELETE .../data`) before it moves the checklist in. The stand-in in
  `e2e/fixtures.ts` answers add, remove, move, switch and pin and the
  settings `PATCH` for the two sample apps and records them in
  `appChanges`; it also keeps groups (the owners'
  list of each in `groups`, the people it knows in `people`, `ownAFamily`
  for a ready family) and records their changes in `groupChanges`. The
  owners' list of a space it was given none for, a personal one included,
  is drawn from the session.
- A phone test checks that nothing reaches past the screen's edge with
  `expectNothingPastTheEdge` (`e2e/fixtures.ts`), never with the document's
  width: the shell clips and the content area scrolls by itself, so the
  document never grows. A part meant to scroll sideways by itself, such as
  the access table's scroller, goes in `SIDEWAYS_SCROLLERS` beside it: what
  is inside it is left to it, and it must fit itself.
- The end-to-end tests start three copies of the real server: the owner's,
  a family member's (Lin, `MEMBER_URL` in `e2e/servers.ts`) and a
  stranger's. The owner's and Lin's share one database file in the system's
  temporary folder (`SHARED_DB`), deleted whenever the owner's copy starts,
  so that a test can be two people on one server. Nothing deletes a space,
  so a group a test creates stays for the tests after it: give it a name of
  its own and do not count groups.
- An app's `useQuery` suspends and is read again after any mutation of the
  same app in the same space that the server answered, saved or turned
  down, on window focus and every 15 seconds while the window is visible
  (`REFRESH_EVERY_MS` in `packages/web/src/apps/scope.tsx`); settings
  likewise. Any `not_found`
  from an app's routes reloads the session (one reload on its way serves
  them all); after a mutation's `not_found` the app is read again only if
  the reloaded session still lists it. Everything cached for one
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
  than `packages/sdk/package.json` has. Every other problem is status 1.
  Two places read it. The deploy script reads it from `pnpm build`, which
  starts with `pnpm apps:sync &&` and so ends with sync's status (pnpm
  passes it on; a test in `packages/sdk/tools/cli.test.ts` checks both): it
  keeps the running release and does not build those commits again (stage
  `sdk` in `state/failed`). The `mini-apps` job in CI reads it from
  `hearth-apps check` and passes with a notice; the CI of `hearth-stones`
  fails on it with a note to merge the SDK change here first. `test` and
  `dev` end with it too, from sync's checks, never from vitest's or the dev
  servers' own status. Keep `build` starting with sync, and keep the status.
- The deploy tests run the real `hearth-apps sync`: each made-up framework
  commit in `deploy/tests/deploy.test.sh` carries a copy of
  `packages/sdk/bin` and `packages/sdk/tools/*.mjs` with an SDK version of
  its own, and the pnpm stand-in's `build` runs it. In the mini-apps folder
  the stand-in makes the links a `link:` dependency asks for, as pnpm does.
- A test that runs `hearth-apps` or `sync()` passes `--out` (or `out`) with
  a temporary folder, as `packages/sdk/tools/cli.test.ts` does, also through
  `pnpm check --out`. Without it the test rewrites this checkout's generated
  files. `test` writes nothing; `dev` refuses `--out`, so its unit tests
  (`tools/dev.test.ts`) call `dev()` with `out` and with the start of the
  servers replaced. The mini-apps repositories those tests make up
  (`tools/test-repos.ts`) lie outside the checkout, linked to the SDK, as
  `hearth-stones` does; one test sets one up exactly as `hearth-stones` is,
  beside a folder named `hearth`, and installs it with the real `pnpm`.
- A mini-apps repository installs nothing but a link to the SDK, so what it
  needs to be checked is a dependency of `@hearth/sdk`: `typescript`,
  `eslint`, `@eslint/js`, `typescript-eslint`, `@types/react`, `vitest`.
  `packages/sdk/tsconfig.app.json` leads `react` to the SDK's copy of
  React's types and `vitest` to the SDK's vitest for the same reason, and
  `resolve.dedupe` in `packages/web/vite.config.ts` gives an app the web
  app's React; without it a build with apps fails.
- An app's tests run inside this repository: `hearth-apps test` (and the
  fifth stage of `check`) starts `packages/server`'s vitest with
  `packages/server/vitest.apps.config.ts`, which reads the apps to test
  from `HEARTH_APP_TESTS` (set by the command; without it the file refuses
  to run) and whose setup file installs `createTestApp`
  (`src/apps/app-testing.ts`) for `testApp`. Its `vitest` import resolves
  to vitest's own copy whatever imports it, and `@hearth/sdk/testing`
  through the app's link to the SDK; both sides reach the same files, so
  the hand-over works. `vitest` started by hand in a mini-apps repository
  has no store: `testApp` then throws and says so.
- `testApp` from `@hearth/sdk/testing` goes through the functions the
  routes use (`callApp`, `readAppSettings`, `changeAppSettings`) and sets
  up its world with the ones that create groups, add people and change
  access, so a change to how the server answers reaches an app's tests by
  itself. Do not give it a second way of answering a call. It is not the
  `testApp` of `packages/server/src/testing.ts`, which builds the Hono app
  for the framework's own tests.
- `@hearth/sdk/testing/host` is for the framework, like
  `@hearth/sdk/web/scope`: the import scan refuses it in a mini-app.
- `hearth-apps dev` runs `pnpm dev` in this checkout with `HEARTH_APPS_DIR`,
  `HEARTH_AUTH=dev` and an owner (`you@example.com` unless
  `HEARTH_OWNER_EMAIL` is set). It starts it in a process group of its own
  and sends a stop signal to the whole group (`startDevServers` in
  `packages/sdk/tools/dev.mjs`): pnpm does not pass a signal on to the
  shell and `concurrently` below it, so signalling pnpm alone leaves both
  servers running; a test in `tools/dev.test.ts` holds it to that. The
  ports 4310 and 5173 are fixed, so a dev server already running, even one
  left from another session, makes it fail to listen.
- A JSON config file may still name `HEARTH_APPS_DIR`; the server ignores
  it (`IGNORED_NAMES` in `packages/server/src/config.ts`), so that a file
  written for an earlier release does not fail the deploy's trial start.
- Who may use an app is decided in one place, the SQL named `VISIBLE` in
  `packages/server/src/apps/installs.ts`, which `resolveInstall` and the
  session both read. A route about one app answers 404 when `resolveInstall`
  gives `null`, whatever the reason, so that the reasons cannot be told apart.
  Do not add a second query that works out access. The owners' list
  (`listSpaceApps`, `GET /api/spaces/:spaceId/apps`) reports what was
  decided (`member_access`, `app_access`) and decides nothing; only the web
  app's table reads an effective level off it, for display, and a test
  (`src/apps/access.test.ts`) checks that reading against the sessions.
- Who may create a group and who may invite someone who is not on the
  server yet is `groupRights` in `packages/server/src/groups/policy.ts`, read
  from `HEARTH_GROUP_POLICY` (`owner`, the default, or `everyone`; owner's
  decision 4). The session's `canCreateGroups` and `canInvitePeople` come
  from it and the routes ask it again; the web app reads the session and
  never decides this itself.
- An invitation to a group is two rows: `invitations` (lets the person onto
  the server) and `space_invitations` (what they become in the group).
  `resolveMember` turns the second into membership in the transaction that
  creates the user (`joinInvitedSpaces` in `src/db/people.ts`). Taking back
  an address's last group invitation deletes its `invitations` row too, since
  a group is the only way in the interface offers; a new way to invite
  someone to the server alone must revisit that.
- A change to `space_members` that could take away the last owner goes
  through `keepingAnOwner` (`src/groups/members.ts`), which turns the
  triggers' `SQLITE_CONSTRAINT_TRIGGER` into 409 `conflict`. Every owner of a
  group manages it (owner's decision 3); anyone may leave; a personal space
  answers 409 to every route about members.
- Exceptions in `app_access` stay when a member becomes an owner, count for
  nothing while they are one, and apply again if they are made a member
  again, so stepping someone down never widens what they had. The access
  route accepts an exception for anyone in the space, owners included.
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
- Moving an app (`moveApp` in `packages/server/src/apps/installs.ts`, one
  immediate transaction) cannot carry a row about a person into a space that
  person is not in: the database refuses it. So it first deletes every
  `app_access` row, and the `app_prefs` and own `app_settings` of people who
  are not in the target (`deleteOwnSettingsOfOthers` in `store.ts`). A new
  table with `space_id`, `app_id` and `user_id` must be cleared there too;
  a test in `apps-schema.test.ts` names the three and fails until it is.
  Access starts afresh where the app goes: no exceptions, members get the
  `memberAccess` asked for ("none" when left out), and a mover who is not
  an owner there gets an `edit` exception, as when adding. A target with an
  entry for the app, removed or not, is 409: nothing is ever merged.
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
