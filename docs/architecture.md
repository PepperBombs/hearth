# Architecture

Hearth is one small server and one web app. This page describes the pieces
that exist today (the app shell) and the rules later steps build on.

## The pieces

| Folder | What it is |
|---|---|
| `packages/shared` | Types and schemas shared by server and web. This is the contract between them: change it first, then both sides. |
| `packages/sdk` | `@hearth/sdk`, the only thing a mini-app imports. So far: `defineApp`, the manifest types, the run-time check of a manifest, the UI kit (`@hearth/sdk/web`), and `defineServer` for an app's queries and mutations (`@hearth/sdk/server`). It also holds the `hearth-apps` command, which builds mini-apps into the framework and checks them, and the ESLint and TypeScript configuration of a mini-apps repository. It imports no other Hearth package. |
| `packages/server` | A Hono app on Node. Answers `/api`, serves the built web app for every other path, and keeps data in one SQLite file. `src/apps` holds the mini-apps this build was given, decides who may use which app in which space, runs an app's queries and mutations against its own rows, and reads and saves its settings. |
| `packages/fixture-apps` | The framework's own sample mini-apps, which its tests run against: `checklist`, which keeps rows, and `feed`, which has a widget and no server file. |
| `packages/web` | A React single-page app built with Vite: sidebar, dashboard, phone tab bar, settings, quick switcher, themes, English and Chinese. It is built from the SDK's UI kit, as mini-apps will be. |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The pull-based deploy script and service files. |

Mini-apps are being built in steps. The server can already hold apps, add
one to a space, remove it, bring it back and delete its data (see "Apps in
spaces" below), run an app's queries and mutations (see "What an app's
code can do") and read and save its settings (see "An app's settings"). A
build takes in the mini-apps of the folders it is told about (see "How
mini-apps get into a build"). The web app carries their widgets but does not
draw them yet: the dashboard shows a plain card for each app, from what the
session says about it. The deploy does not tell its build about any folder
yet, so a deployed server holds no apps. The scheduler does not exist.
The design, and how far the build has come, is in
[mini-app-contract.md](mini-app-contract.md).

## Spaces and roles

Every piece of data belongs to exactly one space and records who created it.

- Each person has one **personal** space, which only they can see.
- A **group** space is a family or team. It may have several owners and
  always keeps at least one. The owners decide which members can see or edit
  each app in it, and who may add apps to it.
- An app is added to a space. Moving an app between a personal and a group
  space moves its data with it.

Today only personal spaces are created. Group spaces, invitations from the
interface and changing who can use an app arrive with the mini-app contract.
The database tables for them exist already, and so do the shapes of the
requests in `packages/shared`. The rules for who may use an app in a group
are built and tested (with groups written straight into a test database);
the routes that create a group or change access are not.

## How mini-apps get into a build

A mini-app is a folder in a repository of its own (`hearth-stones`, or
anyone's laid out the same way), checked out beside this one. It is trusted
code that the server's owner chose to check out: nothing is loaded at run
time, and nothing is sandboxed.

`HEARTH_APPS_DIR` names the folders of mini-apps when the framework is
built: one folder, or several separated like `PATH`. `pnpm build` and
`pnpm dev` first run `hearth-apps sync` (`packages/sdk/tools/sync.mjs`),
which finds every direct child folder that holds a `manifest.ts` and writes
three files that are not in Git:

| File | Holds |
|---|---|
| `packages/server/src/apps/registry.generated.js` | Each app's manifest and, when it has one, its server file. Only `main.ts` imports it. |
| `packages/web/src/apps/registry.generated.js` | Each app's manifest, and its widget and page as files of their own that the browser fetches when first needed. Only `main.tsx` imports it. |
| `packages/web/src/apps/sources.generated.css` | Each app's folder, for Tailwind to read class names from. |

With no folder named, a folder missing or a folder without apps, the three
say "no apps" and the framework builds alone. The running server reads no
apps folder: what a release holds was decided when it was built.

Before it writes anything, sync refuses what must not be built in, and
writes nothing then:

- **Another SDK version.** A folder of apps says in its `package.json`
  which SDK it was written for (`"hearth": { "sdk": "^0.1.0" }`). If
  `packages/sdk/package.json` does not fit that range, sync ends with exit
  status 3, a status it uses for nothing else, and names both versions. Its
  `node_modules/@hearth/sdk` must also be a link to this very checkout.
- **An app ID in two folders**, naming both, and a folder name that cannot
  be an ID.
- **A dependency.** An app's `package.json` declares none.
- **An import a mini-app may not make.** `packages/sdk/tools/import-scan.mjs`
  reads every file of every app with the TypeScript parser. An app imports
  its own files and `@hearth/sdk`; its widget and page also `@hearth/sdk/web`
  and `react`; its `server.ts`, and the files only that imports, also
  `@hearth/sdk/server`. The widget and the page may see the server file's
  types (`import type`) and nothing else of it, so that server code never
  reaches a browser. The scan does not read hidden files or `node_modules`
  folders, so an app may not import from them. No comment switches this off.

The same scan is an ESLint rule (`hearth/mini-app-imports`, from
`@hearth/sdk/eslint`), together with a ban on `fetch`, `process`,
`localStorage`, `eval` and `Function`, so an editor shows a problem before
the build refuses it. The scan is the gate; lint is the early warning.
Neither is a sandbox.

`hearth-apps check` is what a mini-apps repository runs before a merge:
sync, then that every app has its `README.md` and `package.json`, that every
manifest and server file passes the server's own start-up check, the
TypeScript compiler and ESLint. It does not run an app's tests yet.

## Apps in spaces

The server is built with a fixed list of mini-apps: the **registry**
(`packages/server/src/apps/registry.ts`), made from the list the build wrote.
Code arrives with a deploy, never at run time. At start-up every app's
manifest and server file are checked, and a bad one stops the server before
it opens the database, so the deploy's trial of a new release fails and the
old release keeps running.

Whether a space *has* an app is a separate thing, a row in `space_apps`:

| Action | Route | What happens |
|---|---|---|
| Add | `PUT /api/spaces/:spaceId/apps/:appId` | A new entry. The person adding it says what the other members of a group get: nothing (the default), view or edit. Owners may add, and members an owner has allowed to. |
| Remove | `DELETE /api/spaces/:spaceId/apps/:appId` | The entry is marked removed. The app disappears for everyone; its data, settings, switches and pins stay. Owners only. |
| Bring back | the same `PUT` | The mark is cleared and everything is there again. Access starts afresh from what is asked now. Owners only. |
| Delete data | `DELETE /api/spaces/:spaceId/apps/:appId/data` | Rows, settings and the entry are deleted for good. Owners only, with the app's ID typed as confirmation, and only for an app that was removed or whose code is gone. |

Who may use an app is one question with one answer,
`resolveInstall(db, registry, userId, spaceId, appId)`, which gives `"view"`,
`"edit"` or nothing:

- Nothing for someone who is not in the space, for an app the space does not
  have or that was removed from it, and for an app the server holds no code
  for.
- An owner of the space has edit. In a personal space that is its one member.
- A member has the exception an owner made for them, or else what the app
  gives every member; "none" is nothing.

"Nothing" is answered with `404 not_found` on every route about that app, so
none of the reasons can be told apart, and the session lists only apps with
an answer. The session and `resolveInstall` read the same SQL.

If an app's folder is taken out of a deploy, the app disappears from every
session and its data is left exactly as it was. Putting the folder back
brings the app back.

## What an app's code can do

A mini-app's `server.ts` names its **collections** (a zod schema for the rows
of each) and its routes: **queries**, which read, and **mutations**, which
change data. Each route carries one English sentence saying what it does, so
that an assistant can later pick routes by it; an app whose route has none
does not start.

```ts
import { defineServer, z } from "@hearth/sdk/server";
import manifest from "./manifest";

const app = defineServer(manifest, {
  items: z.object({ name: z.string().trim().min(1).max(80), done: z.boolean().default(false) }),
});

export default app.routes({
  list: app.query({ description: "Lists every item, oldest first." }, (ctx) => ctx.db.items.list()),
  add: app.mutation(
    { description: "Adds an item to the list.", input: z.object({ name: z.string() }) },
    (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
  ),
});
```

The web app calls a route with `POST /api/spaces/:spaceId/apps/:appId/q/:name`
(a query) or `.../m/:name` (a mutation). What the server does with it is the
same for every app:

1. It opens one database transaction and asks `resolveInstall` what this
   person may do. Nothing is `404`; a mutation with view only is `403`.
2. It checks the input against the route's schema (`400`).
3. It builds the handler's `ctx`: the person, their language, the space's
   kind and name, their access, the app's settings here (the space's values
   and this person's own), the time, and `db`.
4. It runs the handler, still inside the transaction, and sends what it
   returns as JSON. A handler is not `async`; one that returns a promise is
   refused.

The scoping rule of the whole project, every row belongs to a space, is kept
by what the handler is *not* given. It has no database handle and no space
ID, and nothing in the SDK takes one. `ctx.db` is built by the server from
the space and app in the address, after the access check, and every
statement it runs carries that space, that app and the collection's name
(`packages/server/src/apps/store.ts`, the only file with SQL for app data).
A row ID from another space is "not found". A query's `db` has no methods
that write. The store stops working when the handler returns, so nothing can
be read or written outside the transaction that checked access.

Rows are JSON documents, checked against the collection's schema when
written and again when read. There are no migrations for app data: a field
added later gets a default, and rows stored before it count as holding that
default. A stored row that no longer fits fails the query, with the app,
the collection and the row in the server's log.

A handler turns a request down by throwing `AppError` (`invalid_request`,
`not_found` or `conflict`). Anything else that goes wrong in a handler is
logged and answered with `500`, and whatever the mutation wrote is undone.

## An app's settings

A manifest declares the app's settings: a name, a type (text, number,
switch, select, multi-select, list), a label and a default each. Every
setting has a scope. A `space` setting has one value, shared by everyone in
the space; a `user` setting has one value for each person in that space.
The same app in another space has other values.

| Route | Who | What happens |
|---|---|---|
| `GET /api/spaces/:spaceId/apps/:appId/settings` | Anyone who can see the app. | Answers `{ space, user }`: every declared setting under its scope, with the shared value or the caller's own. |
| `PATCH` on the same address | `space`: edit access. `user`: view is enough. | Saves the settings named in `{ space?, user? }` and answers like the `GET`. A name the manifest does not declare under that scope, or a value that does not fit its setting, is `400`, and then nothing in the request is saved. |

Only values are stored, as one JSON object for the space and one per
person, and they are read against the manifest as it is today:

- A setting nobody saved has the manifest's default. Nothing is copied into
  the database when an app is added, so a default can change with a release.
- A value saved under a name the manifest no longer declares is not read.
  It is not deleted either: saving replaces the named values and leaves the
  rest, so a release that is rolled back finds its values again.
- A saved value that no longer fits its setting, such as an option that is
  gone, reads as the default. A multi-select keeps the options that remain.

What a setting declares (`maxLength`, `min`, `max`, `step`, the options,
`maxItems`) is the rule for its default and for every value saved in it;
one function in the SDK checks both. A number with a `step` is `min` (or 0)
plus a whole number of steps, as in a form's number field.

A handler reads the same values, in one object by name, as `ctx.settings`.

## Where an app's data lives

The database has no table per mini-app. `space_apps` says which app is in
which space; every other table about apps refers to it by space and app
together:

| Table | Holds |
|---|---|
| `space_apps` | An app added to a space, what its members get by default, and when it was removed. Removing keeps the data. |
| `app_rows` | Every mini-app's data, one JSON document per row. |
| `app_settings` | Settings values: one JSON object for the space and one per person. |
| `app_access` | An owner's exception for one member. |
| `app_prefs` | Each person's own switch and pin. |
| `space_invitations` | People added to a group before they first arrived. |

The database itself keeps three rules, so that no code path can break them:

- A row for an app the space does not have is refused.
- Moving an app is one change of `space_apps.space_id`, which every table
  above follows. Rows about a person (access, switch, own settings) cannot
  arrive in a space that person is not in, and go when the person leaves.
- An app's entry cannot be deleted while it has rows or settings, and a space
  cannot be deleted while it has apps. Data goes only when it is deleted on
  purpose.

## Who is this request from?

The server has no login page. Identity sits behind one function:

```ts
type Identify = (request: Request) => Promise<{ email: string } | null>;
```

- `cloudflare-access` verifies the signed token Cloudflare Access attaches to
  each request (issuer, audience, expiry, signature) and reads the email from
  it. A plain email header is never trusted.
- `dev` treats every request as one configured address. It refuses to start
  unless the server listens on a loopback address, and then answers only
  requests addressed to this machine by a loopback name: a web page elsewhere
  that points its own host name at 127.0.0.1, or a tunnel on the same
  machine, gets nothing.

An email address has one spelling everywhere: lower case, accented letters in
composed form. An address containing a character that only stands for an
ASCII one (the Kelvin sign for "k", a full-width letter) is refused, so a
look-alike of someone's address is never taken for that person.

After identity comes membership: the owner's address is let in, as is anyone
with an invitation; everyone else gets "not a member".

## Three repositories

`hearth` (this one, public), `hearth-stones` (public, one folder per mini-app)
and `hearth-data` (private, the owner's content) are checked out side by side
on the server. The database file and secrets live in none of them.

## Deployment

A timer on the server runs `deploy/hearth-deploy.sh` every minute. It fetches
`main` of the framework and the mini-apps, and only when something changed
builds a fresh release, tries it on a spare port against a copy of the
database, switches a `current` link to it and restarts the service. If the
build or the trial fails, the old release keeps running untouched. If the new
release fails as the live service, the script goes back to the old release
and puts the database back as it was just before the switch, because an older
build refuses a database that a newer build has migrated. There is no
self-hosted GitHub Actions runner, because the repositories are public. See
[self-hosting.md](self-hosting.md).

## Checks

`pnpm check` runs type checking, lint and unit tests; `pnpm e2e` runs the
end-to-end tests. CI runs all of them on GitHub's own runners.

Type checking covers the four packages, the fixture apps and, with its own
`tsconfig.json`, the `e2e` folder and `playwright.config.ts`. The SDK's types are themselves
under test: `packages/sdk/src/index.test.ts` states what a manifest's settings
and strings must come out as, `server.test.ts` beside it does the same for a
handler's context and a route's input and output, and a wrong type there
fails the type check.
The UI kit's unit tests run in the SDK, in a simulated browser. They cannot
see styles: the kit's classes are turned into a stylesheet by the web app's
build, and an end-to-end test (`e2e/shell.spec.ts`) checks that they arrive.
Lint also holds the fixture apps to the rules for every mini-app: import the
SDK and your own files, nothing else, and leave the globals that reach
outside alone.
The `hearth-apps` command is tested as it is run (`packages/sdk/tools`):
against the fixture apps, and against mini-apps repositories made up in a
temporary folder outside the checkout, each with one thing wrong. Those
tests send the generated files to a temporary folder too.
The end-to-end tests build with the fixture apps, so the whole path is
tried: from an app's folder to a server that answers for it and a web app
that carries its widget and its styles.
`pnpm test` also runs `deploy/tests/deploy.test.sh`, which drives the real
deploy script through a failed trial, a failed switch with the database put
back, and a restart that cannot be confirmed, using stand-ins for git, pnpm
and systemctl.

TypeScript is held at version 6 on purpose. The lint tooling
(`typescript-eslint`) does not yet support TypeScript 7; if TypeScript is
upgraded before it does, `eslint.config.js` warns that TypeScript files are
not being linted, and CI fails rather than skip them.
