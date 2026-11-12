# Architecture

Hearth is one small server and one web app. This page describes the pieces
that exist today (the app shell) and the rules later steps build on.

## The pieces

| Folder | What it is |
|---|---|
| `packages/shared` | Types and schemas shared by server and web. This is the contract between them: change it first, then both sides. |
| `packages/sdk` | `@hearth/sdk`, the only thing a mini-app imports. So far: `defineApp`, the manifest types, the run-time check of a manifest, the UI kit and the hooks of a widget or page (`@hearth/sdk/web`), `defineServer` for an app's queries and mutations (`@hearth/sdk/server`), and `testApp` for an app's own tests (`@hearth/sdk/testing`). It also holds the `hearth-apps` command, which builds mini-apps into the framework, checks them, runs their tests and runs Hearth with them for development, and the ESLint and TypeScript configuration of a mini-apps repository. It imports no other Hearth package. |
| `packages/server` | A Hono app on Node. Answers `/api`, serves the built web app for every other path, and keeps data in one SQLite file. `src/apps` holds the mini-apps this build was given, decides who may use which app in which space, runs an app's queries and mutations against its own rows, reads and saves its settings, and runs its jobs on a schedule. `src/groups` creates groups and manages the people in them. |
| `packages/fixture-apps` | The framework's own sample mini-apps, which its tests run against: `checklist`, which keeps rows and has a page, `feed`, which has a widget and no server file, and `headlines`, whose job fetches a sample news feed every hour. |
| `packages/web` | A React single-page app built with Vite: sidebar, dashboard, phone tab bar, settings (with a card for each group), quick switcher, themes, English and Chinese. It is built from the SDK's UI kit, as mini-apps are, and draws each app's widget on the dashboard and its page at `/apps/:spaceId/:appId`. |
| `e2e` | Playwright end-to-end tests: the framework with its sample apps, and in `e2e/mini-apps` the mini-apps of `hearth-stones`. |
| `deploy` | The pull-based deploy script and service files. |

Mini-apps are being built in steps. The server can already hold apps, add
one to a space, remove it, bring it back and delete its data (see "Apps in
spaces" below), run an app's queries and mutations (see "What an app's
code can do") and read and save its settings (see "An app's settings"). A
build takes in the mini-apps of the folders it is told about (see "How
mini-apps get into a build"), and the web app draws their widgets and pages
(see "How the shell draws an app"). On the Apps page a person adds an app
to a space, switches it on or off and pins it for themselves, and an owner
moves it with its data to another space or removes it; a dialog drawn from
the manifest changes an app's settings (see "The Apps page and the settings
dialog"). In Settings the server's owner creates groups, and the owners of a
group add and invite people and decide who can use each app (see "Groups,
people and access"). The deploy builds every release with the mini-apps of
`hearth-stones` as they are at that moment (see "Deployment"), and an app's
own tests call its routes against the server's real store (see "Working on
mini-apps"). The first mini-app, the grocery list, is in `hearth-stones`.
A scheduler in the server runs the apps' jobs, what an app does by itself
every so often, and a widget shows how they went and asks for a run (see
"What an app's code can do"); the framework's sample headlines are an app
with a job, from its manifest to its card.
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

Groups are created in Settings; see "Groups, people and access" below.
Moving an app is described under "Apps in spaces".

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
apps folder: what a release holds was decided when it was built. On the
server, the deploy names the copy of `hearth-stones` that lies beside the
framework in each release.

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
`localStorage`, `eval` and `Function` (an app fetches only in a job, with
`ctx.fetch`), so an editor shows a problem before the build refuses it.
The scan is the gate; lint is the early warning. Neither is a sandbox.

`hearth-apps check` is what a mini-apps repository runs before a merge:
sync, then that every app has its `README.md` and `package.json`, that every
manifest and server file passes the server's own start-up check, the
TypeScript compiler, ESLint, and the app's own tests.

## Working on mini-apps

`hearth-stones` lies beside this repository, as on the server. Its
`package.json` says which SDK version its apps are written for and links
`@hearth/sdk` from `../hearth/packages/sdk`; its lockfile holds that link and
nothing else, so `pnpm install` there downloads nothing and the server's
deploy runs it offline. Its `tsconfig.json` and `eslint.config.js` are one line each,
from the SDK, and its commands are the SDK's `hearth-apps`:

| Command there | Does |
|---|---|
| `pnpm check` | `hearth-apps check` (above). CI runs it on every pull request, with `main` of this repository checked out beside it, then builds Hearth with the apps. |
| `pnpm test` | `hearth-apps test`: the apps' own tests. |
| `pnpm dev` | `hearth-apps dev`: sync, then this repository's `pnpm dev` with the apps in and sign-in switched off. A change to a widget or page shows without reloading the page; one to a manifest or server file restarts the server. The script is `exec hearth-apps dev`, so that a stop sent to pnpm alone reaches the command, which stops both servers; they also stop when pnpm is gone. |
| `pnpm new <id>` | `hearth-apps new`: a new app in a folder named `<id>`, as a copy of this repository's sample checklist (`packages/fixture-apps/checklist`) with the new ID, a test file named after it and a README that says what to change first. It passes `pnpm check` as it is, and overwrites nothing. |

An app's tests are written with `testApp(server)` from `@hearth/sdk/testing`:
the app in a space of a database of its own, and people in it who call its
queries and mutations, each with view or edit access. The SDK only hands the
call over. The framework answers it (`packages/server/src/apps/app-testing.ts`)
with the functions the routes use, the access check, the store and the
transaction included, so a test sees what a browser would. A test runs a
job with `runJob`, through the code the scheduler runs it with, while a
function of the test answers what passes the rules of `ctx.fetch` in place
of the network; a person's `job` and `requestRun` read its status and ask
for a run through the functions of the job's two routes. That is why the
tests run inside this repository: `hearth-apps test` starts the server
package's vitest with `packages/server/vitest.apps.config.ts`, whose setup
file installs the implementation.

An app's end-to-end test, two people of a family using it in their
browsers, is in this repository too, in `e2e/mini-apps`, named after the
app: `hearth-stones` has no Playwright. `pnpm e2e:mini-apps` runs it here
against Hearth built with `../hearth-stones` (see "Checks"). So a change to
an app's texts or layout there changes its file here as well.

`hearth-stones` holds one app so far, the grocery list (`grocery/`): a
shopping list the people of a space share, grouped by the aisles the space
sets, which each person may show with or without what is ticked.

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
| Move | `POST /api/spaces/:spaceId/apps/:appId/move` | The entry goes to another space with its rows and the settings everyone shares, and so do the own settings, switches and pins of people who are in both spaces; those of everyone else are deleted. Access starts afresh: no exceptions, members get what the mover chooses (nothing by default), and a mover who is not an owner there keeps edit. Owners of the space it is in, into a space they own or may add apps to, whose kind the manifest allows and which never had the app (a removed one counts): nothing is merged. |
| Delete data | `DELETE /api/spaces/:spaceId/apps/:appId/data` | Rows, settings and the entry are deleted for good. Owners only, with the app's ID typed as confirmation, and only for an app that was removed or whose code is gone. |
| Switch and pin | `PATCH /api/spaces/:spaceId/apps/:appId/me` | The caller's own switch (`enabled`) and pin (`pinned`), nobody else's. Anyone who can see the app, view access included. Switching an app off hides it for that person only and changes no one's access. |

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

A server file may also define **jobs** (`app.job`): what the app does by
itself, every 15 minutes to once a week, once for each space it is in and
for no one in it, such as fetching the latest headlines of a feed. A job
sits in `app.routes` beside the queries and mutations, with a one-sentence
description of its own and how often it runs, so that one list says
everything an app does. It is never a route: `/q/` and `/m/` answer `404`
for its name. Its function may wait, because it fetches, but it reads and
writes rows only inside `ctx.read` and `ctx.write`, each one transaction
whose work may not wait, so that no transaction is held open across the
network. Only a job fetches, with `ctx.fetch`, and only from the hosts the
manifest lists in `network`; an app that names hosts without a job does not
start. The start-up check holds every job to its description, its interval
and taking no input.

`ctx.fetch` (`packages/server/src/apps/fetch.ts`) holds every request to
the same rules before it goes out: GET over https, on the default port, to
a host the manifest lists exactly; `User-Agent: Hearth` and a few headers
that carry nothing of anyone's, so no cookie and no `authorization`;
redirects only while they stay on https and the same host; 20 seconds and
2 MiB for an answer. Requests to one host start at least 6.5 seconds apart
across the whole server, which keeps every space's jobs together within
GitHub's 10 searches a minute for an address without a token. A server
sends them with Node's own `fetch`; for end-to-end tests,
`HEARTH_FETCH_STANDINS` names a file of stand-in answers instead, which
only a server in dev mode accepts, so that no test reaches the network.

A run of a job is claimed, run and recorded by
`packages/server/src/apps/jobs.ts`. The claim is the job's row in
`app_jobs` (migration 3): it holds the job for one run at a time, also
across processes that share the database, and another run takes it over
once the run's 5 minutes, and one more, have passed. A run gets `ctx.read`
and `ctx.write`, which check inside their own transaction that the run
still holds its install (the app not removed, moved away or deleted)
before they read or write, in the name of whoever added the app; so no
transaction waits on the network, and nothing is written after a removal,
a move or a deletion. A run that went wrong is tried again after 5, 10, 20
... minutes, never more than the job's interval; one that went well is
followed by the next an interval to a tenth more after it started.

The scheduler (`packages/server/src/apps/scheduler.ts`) starts the runs on
a server, one at a time across the whole server: the job that falls due
first, and a job that has not run in an install at once, so an app's first
run follows its being added. With nothing due it sleeps until the next job
is, at most 30 seconds, so that what another process sharing the database
changed is seen within that, and adding an app or bringing one back wakes
it, as does a run someone asked for. All it knows is in `app_jobs`, so a
restart goes on where the last process stopped. `main.ts` starts it once
the server listens and stops it before the database closes, ending the
run going on at once; `createApp` starts none, so tests run no job unless
one asks. `HEARTH_JOBS=off` keeps it from starting: the deploy's trial
start runs that way. Nothing the end-to-end tests do reaches a real host:
the copies of the server they start run no job, except the owner's and the
member's in `pnpm e2e`, whose jobs get every answer from a file of
stand-ins (see "Checks").

A job's two routes are what people see of it. `GET
/api/spaces/:spaceId/apps/:appId/jobs/:job`, for anyone who can see the
app, says how its runs went in that space: when the last one started,
went well and went wrong, the last error, when the next is due, and
whether one is going on (`running`) or was asked for (`requested`). `POST
.../jobs/:job/run`, with edit access, asks for a run now ("Refresh now"):
it starts at once, or 5 minutes after the last run started, never sooner,
so asking again and again cannot hammer a host. Both answer `404` when the
app is not there for the person or has no job of that name, a query's
name included, so that nothing can be learnt from them.

The framework's sample headlines (`packages/fixture-apps/headlines`) are a
whole app with a job, to read beside this section. The manifest names one
host, `feeds.example.com`; the job `refresh` runs every hour, fetches the
feed, and puts its first five titles in place of those kept before, in one
`ctx.write`, or fails and keeps them. Its widget reads `useJob("refresh")`:
the headlines, "Updated 12 min ago" (a time of day after an hour and a
half), "Refreshing…" while a run is going on or asked for, "Couldn't reach
the feed at 14:05. Showing headlines from 13:05." when the last run failed,
and "Refresh now" for someone who may edit. Its own tests run the job with
`runJob` and stand-ins for the feed.

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

## How the shell draws an app

The dashboard has a card for each app the session lists and the person has
switched on, in the size its manifest asked for. The shell draws the card's
frame: icon, name, the group's tag, and "Open" when the app has a
`page.tsx`. Inside it is the app's `widget.tsx`; at
`/apps/:spaceId/:appId` (and anything below it, for later) the shell draws
the top bar and the app's `page.tsx` below it.

An app's code is fetched only when it is first drawn. Until it and its first
answers are there, the card shows a skeleton; when they fail, a message and
"Try again"; when a change fails, a notice under the widget. A fault in one
app's code stays in that app's card. An app the session lists but this
browser's copy of Hearth does not hold gets "Reload to update": the server
was updated after the page was opened.

A widget or page is written with the hooks from `appHooks<typeof
server>()` in `@hearth/sdk/web`, typed from the app's own server file:

- `useApp()`: `t` for the app's own strings, the reader's language, the
  reader, the space and its members (no IDs of spaces), the access level,
  the settings and the address of the app's page.
- `useQuery(name, input?)`: the answer of a query. It suspends, so the app
  has no loading code.
- `useMutation(name)`: `run(input?)`, `pending` and `error`. After a
  mutation succeeds, every query of that app in that space is read again.
- `useJob(name)`: how one of the app's jobs is doing here, for "Updated
  12 min ago", a banner when the last run failed and "Refresh now":
  `succeededAt`, `failedAt`, `running`, `canRun`, `run()` and `pending`.
  It suspends for the first status, as a query does.

What the hooks read is put around the widget by `<AppScope>`
(`packages/web/src/apps/scope.tsx`), which knows the space and the app and
makes the calls; the app never builds an address. Queries, settings and
jobs' statuses are read again when the window gets the focus back and every
15 seconds while it is visible, which is how family members see each
other's changes. Nothing is pushed. A job's status is read every 3 seconds
while a run is going on or was asked for, and once a run went well every
query of the app is read again before the new status shows, so the data
on the screen is never older than its "Updated ..." says. A `not_found` from any of an app's routes means it is no
longer there for this person (removed or moved, or access taken away), so
the session is loaded again and the card goes.

## The Apps page and the settings dialog

The Apps page (`packages/web/src/pages/apps.tsx`) lists every app the
session lists, by space, those switched off included, so that they can be
switched on again. "Pinned" at the top holds shortcuts to the pinned ones,
and pinned apps come first on the dashboard, in the sidebar and in each
space's list. Each row has the person's own pin and switch, the app's
settings and, for an owner of the space, "Remove", which asks first and
says that the data is kept, and "Move" where there is somewhere to move it:
another space where the person may add apps, which does not have it and
whose kind the manifest allows. The move dialog says what goes along and,
from a group, who loses the app; afterwards the space it went to says so
and takes the focus. Where the person may add apps, "Add an app" offers the
apps this build holds that the space does not have and whose manifest
allows its kind, or says why there are none. Adding an app to a group, and
moving one into a group, asks who else may use it, "only me for now" first.
An app the space removed is offered too: for an owner the dialog reads the
space's owners' list first and says that adding it again brings back its
data, with how many entries, and its button says "Bring back". An app
whose manifest lists hosts in `network` is said to fetch data from them on
its own ("Fetches data from api.github.com on its own."), new or brought
back; the dialog asks nothing more about it. Whatever the server answers
to adding, removing or moving, the session and the owners' list are loaded
again, so a page that was out of date catches up. The page is "Apps" in
the sidebar and in the phone's tab bar, and the empty dashboard and the
group cards link to it.

The settings dialog (`packages/web/src/apps/settings-dialog.tsx`) opens
from the Apps page, from the button on the app's card and from the top bar
of its page. It draws one control per setting from the manifest: a text box,
a number box with its limits in words, a switch, a row of choices, chips for
a multi-select, and an editable list. "For everyone in this space" holds the
space's settings, read-only for someone who may only view; "Only for you"
holds the reader's own. Saving sends only the values that were changed, and
the app's queries are read again afterwards, since a route may read its
settings.

## Groups, people and access

Who may create a group, and who may invite someone who is not on the server
yet, is decided by one function on the server, `groupRights`
(`packages/server/src/groups/policy.ts`), from one setting,
`HEARTH_GROUP_POLICY`: the server's owner alone (`owner`, the default), or
everyone on the server (`everyone`). The session tells the web app what it
says, and the routes ask it again.

| Action | Route | Who |
|---|---|---|
| Create a group | `POST /api/spaces` | Whoever `groupRights` allows. They become its owner. |
| Rename it | `PATCH /api/spaces/:spaceId` | Its owners. |
| Add someone | `POST /api/spaces/:spaceId/members` | Its owners. Someone on the server becomes a member at once; anyone else is invited, if `groupRights` allows, and joins when they first open Hearth. |
| Change a member | `PATCH /api/spaces/:spaceId/members/:userId` | Its owners: the member's role, and whether they may add apps. |
| Remove a member, or leave | `DELETE /api/spaces/:spaceId/members/:userId` | Its owners, or the member themselves. |
| Take an invitation back | `DELETE /api/spaces/:spaceId/invitations` | Its owners. |
| See who can use what | `GET /api/spaces/:spaceId/apps` | Its owners: every app with what members get and the exceptions, every person with their address, the invitations. |
| Change who can use an app | `PUT /api/spaces/:spaceId/apps/:appId/access` | Its owners: what every member gets, and exceptions for single members. |

- A group may have several owners and always keeps one: the database
  refuses to remove or demote the last, and the server answers `409`.
- An invitation is two rows: one in `invitations`, which lets the person
  onto the server, and one in `space_invitations`, which says what they
  become in the group. When they first arrive, both are used up in the
  transaction that creates them. Taking back an address's last invitation
  to a group takes back its invitation to the server too.
- A new member gets what every member gets of each app. Exceptions for one
  member stay when they become an owner, who can use every app anyway, and
  count again if they stop being one.
- Someone who leaves loses their exceptions, switches, pins and own
  settings in the group; the rows they wrote stay with the group.
- A personal space has no members to manage: nobody joins, leaves or
  renames it.

Changing access never touches the code that decides it: `resolveInstall`
reads the same rows the owners' list reports.

In the web app (`packages/web/src/groups`), Settings has a card for each
group the person is in. Everyone sees its people and can leave it; its
owners also rename it, add and invite people, manage each person in a
dialog, take invitations back, and choose access in a table with one row
per app and a column for every member, "Everyone" first.

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
| `space_invitations` | People added to a group before they first arrived, with what they become there. |

The database itself keeps three rules, so that no code path can break them:

- A row for an app the space does not have is refused.
- Moving an app is one change of `space_apps.space_id`, which every table
  above follows. Rows about a person (access, switch, own settings) cannot
  arrive in a space that person is not in, so a move deletes those first,
  and they go when the person leaves.
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
builds a fresh release: both repositories at their new commits, side by side
in a folder of their own. The mini-apps are linked to the SDK of that
release with an offline install, since their lockfile holds nothing but that
link, and the framework is built with them in. The script then tries the
release on a spare port against a copy of the database, with the mini-apps'
jobs switched off so that the trial fetches nothing, switches a `current`
link to it and restarts the service. If the build or the trial fails, the
old release keeps running untouched. If the new release fails as the live
service, the script goes back to the old release and puts the database back
as it was just before the switch, because an older build refuses a database
that a newer build has migrated. There is no self-hosted GitHub Actions
runner, because the repositories are public. See
[self-hosting.md](self-hosting.md).

Mini-apps written for another version of the SDK than the framework holds
stop the build with status 3 (see "How mini-apps get into a build"). The
release that runs stays, those commits are not built again, and the next
commit of either repository is built at once. So a change that breaks the
SDK goes out in two merges: raise the SDK's version here, then merge the
matching change in `hearth-stones`; in between the server keeps the release
it runs.

## Checks

`pnpm check` runs type checking, lint and unit tests; `pnpm e2e` runs the
end-to-end tests. CI runs all of them on GitHub's own runners. A third job
in CI builds every change with `main` of `hearth-stones` checked out beside
it, as the server would build the two: it links the mini-apps offline, runs
`hearth-apps check` on them, builds, and runs their end-to-end tests
(`pnpm e2e:mini-apps`, below). Mini-apps written for another SDK
version pass with a notice, since that is expected between raising the
version here and the matching change there; any other failure means a change
here broke them without raising the version.

Type checking covers the four packages, the fixture apps and, with its own
`tsconfig.json`, the `e2e` folder and the two Playwright configurations. The SDK's types are themselves
under test: `packages/sdk/src/index.test.ts` states what a manifest's settings
and strings must come out as, `server.test.ts` beside it does the same for a
handler's context and a route's input and output, and a wrong type there
fails the type check.
The UI kit's unit tests run in the SDK, in a simulated browser. They cannot
see styles: the kit's classes are turned into a stylesheet by the web app's
build, and an end-to-end test (`e2e/shell.spec.ts`) checks that they arrive.
Lint also holds the fixture apps to the rules for every mini-app: import the
SDK and your own files, nothing else, and leave the globals that reach
outside alone. The sample checklist and headlines have tests of their own,
written with `testApp` as any mini-app's are, the headlines' running their
job with stand-ins for the feed; `pnpm test` runs them with
`hearth-apps test`.
The `hearth-apps` command is tested as it is run (`packages/sdk/tools`):
against the fixture apps, and against mini-apps repositories made up in a
temporary folder outside the checkout, each with one thing wrong. Those
tests send the generated files to a temporary folder too. One of them sets
up a repository exactly as `hearth-stones` is, beside a folder named
`hearth`, installs it with the real `pnpm install --frozen-lockfile
--offline` and runs `pnpm check` there, with no apps and with one; another
makes an app there with `pnpm new` and checks it untouched, since an app
made from the template must pass as it is.
The end-to-end tests build with the fixture apps, so the whole path is
tried: from an app's folder to a server that answers for it and a web app
that draws its widget and page with their styles. One of them ticks an
item in a widget against the real server, sees it ticked on the app's page
and checks that the Content-Security-Policy refused nothing. Two copies of
the real server share one database file, one signed in as the owner and one
as a member of the owner's family, so that one test can be two people: the
owner invites the member, chooses what she may do with an app, and lets her
add one. Those two copies also run their jobs, and one file of stand-in
answers that the tests write (`HEARTH_FETCH_STANDINS`) answers every
request they make, so a job runs on the real server without reaching the
network: the owner adds the sample headlines to the family, the dialog
names the host they fetch from, the first run follows at once and the card
says "Updated just now"; with the stand-in failing, "Refresh now" keeps the
headlines and says when the refresh failed; and the member, who may only
view, reads the same card on her phone, in Chinese, with no button. The
copy of a stranger runs no job. The tests that answer `/api` themselves
answer a job's routes too, so that the card's other states (the minutes
going on, the time of day, a run asked for and ending, the empty card) are
tried with a clock the test moves.
The mini-apps of `hearth-stones` have their end-to-end tests here as well,
in `e2e/mini-apps`, because that repository installs nothing but the link
to the SDK and so has no Playwright. `pnpm e2e:mini-apps` builds Hearth
with them, starts the owner's and the member's copies of the server again,
and runs the file of each app the build holds: for the grocery list, two
people of a family sharing one list, each on their own screen, one of them
on a phone and in Chinese, who see each other's changes without
reloading.
`pnpm test` also runs `deploy/tests/deploy.test.sh`, which drives the real
deploy script through a failed trial, a failed switch with the database put
back, and a restart that cannot be confirmed, using stand-ins for git, pnpm
and systemctl. It also builds mini-apps in, and turns down mini-apps that
cannot be linked and mini-apps written for another SDK version: the made-up
commits carry the real `hearth-apps sync`, so that check is the real one.

TypeScript is held at version 6 on purpose. The lint tooling
(`typescript-eslint`) does not yet support TypeScript 7; if TypeScript is
upgraded before it does, `eslint.config.js` warns that TypeScript files are
not being linted, and CI fails rather than skip them.
