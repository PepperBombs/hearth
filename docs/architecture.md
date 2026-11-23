# Architecture

Hearth is one small server and one web app. This page describes the pieces
and the rules they keep. How an app is made in Hearth, run in the browser's
sandbox and changed in the chat is `docs/platform.md`.

## The pieces

| Folder | What it is |
|---|---|
| `packages/shared` | Types and schemas shared by server and web. This is the contract between them: change it first, then both sides. |
| `packages/sdk` | `@hearth/sdk`: the rules every app's manifest keeps to (its types, the lists of icons, colours and card sizes, and the run-time check of a manifest and of a setting's value), and the UI kit (`@hearth/sdk/web`) the web app is built from. It imports no other Hearth package. |
| `packages/server` | A Hono app on Node. Answers `/api`, serves the built web app for every other path, and keeps data in one SQLite file. `src/apps` decides who may use which app in which space, keeps an app's rows and settings, and makes its fetches; `src/made` keeps the apps made in Hearth, serves their pages to the sandbox and holds the built-in ones (`catalog`); `src/model` is each person's own model and the chat; `src/groups` creates groups and manages the people in them. |
| `packages/web` | A React single-page app built with Vite: sidebar, dashboard, phone tab bar, settings (with a card for each group), quick switcher, the chat, themes, English and Chinese. It is built from the SDK's UI kit, and draws each app's page in its sandbox, small on the dashboard and whole at `/apps/:spaceId/:appId`. |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The pull-based deploy script and service files. |

Every app is made in Hearth (`docs/platform.md`): a manifest and one HTML
page, kept in the database. A person makes one in the chat with their own
model, or adds one of the apps Hearth ships from the Apps page, and changes
it in the chat; its page is drawn in the browser's sandbox and reaches its
own rows through the page around it (see "What an app's page can do"). On
the Apps page a person switches an app on or off and pins it for
themselves, and an owner moves it with its data to another space or
removes it; a dialog drawn from the manifest changes an app's settings
(see "The Apps page and the settings dialog"). In Settings the server's
owner creates groups, the owners of a group add and invite people and
decide who can use each app (see "Groups, people and access"), and each
person saves their own model. The deploy builds every release from `main`
of this repository (see "Deployment").

Until November 2026 apps were also written by hand against the SDK and
built into each release from a repository of mini-apps beside this one.
[mini-app-contract.md](mini-app-contract.md) is the record of that design,
and of the rules for apps in spaces, which stay.

## Spaces and roles

Every piece of data belongs to exactly one space and records who created it.

- Each person has one **personal** space, which only they can see.
- A **group** space is a family or team. It may have several owners and
  always keeps at least one. The owners decide which members can see or edit
  each app in it, and who may add apps to it.
- An app is made in a space, or added to it from the apps Hearth ships,
  and lives there alone. Moving an app between a personal and a group space
  moves its data with it.

Groups are created in Settings; see "Groups, people and access" below.
Moving an app is described under "Apps in spaces".

## An app

An app is a row of `made_apps`: its manifest, its page and the version in
use, every earlier version kept in `made_app_versions` (the newest 30). Its
manifest (`packages/server/src/made/manifest.ts`) gives its name and
description, in its maker's words or in both languages for a built-in app,
an icon and a colour from the SDK's lists, the size of its card, its
collections of simple fields, its settings, and, for a built-in app alone,
the hosts it may fetch from (`network`). The server checks it when it is
written, its settings and hosts by the SDK's own rules
(`checkMadeManifest`). Its page is one HTML document, everything inline.

The server holds no other kind of app. The **registry**, which every part
of it asks whether an app exists, is `madeAppsRegistry(db)`
(`packages/server/src/made/apps.ts`), read from the database each time.
Hearth's own code and its built-in apps' pages arrive with a deploy; a
page a person's model writes arrives in a request. Either way a page is
kept as data, and runs only in the browser's sandbox, never on the server.

The apps Hearth ships (`packages/server/catalog`) are made apps too,
written by hand: the grocery list, Ideas and GitHub Trending. They are
checked when the server starts, and a broken one stops it before it
listens, so the deploy's trial of a new release fails and the old release
keeps running. Then every copy nobody changed is brought up to this
release's, and every install of the mini-apps of the same names that
earlier releases left is moved to the built-in app, in place, data and all
(`packages/server/src/made/builtin.ts`).

## Apps in spaces

Whether a space *has* an app is a row in `space_apps`, its install, under
the made app's ID. An app is added to its space when it is made, and lives
there alone until it is moved:

| Action | Route | What happens |
|---|---|---|
| Make | `POST /api/chat`, whose model calls `create_app` | A new app and its install, made by the person's own model. Owners may make apps, and members an owner has allowed to add apps, where the space's owners let an assistant read and change. |
| Add a built-in app | `POST /api/spaces/:spaceId/catalog/:templateId` | A copy of the built-in app, made in the space, which can then be changed like any. A space has one of each. Owners may add, and members an owner has allowed to. |
| Remove | `DELETE /api/spaces/:spaceId/apps/:appId` | The entry is marked removed. The app disappears for everyone; its data, settings, switches and pins stay. Owners only. |
| Bring back | `PUT /api/spaces/:spaceId/apps/:appId`, or adding the same built-in app again | The mark is cleared and everything is there again. Access starts afresh from what is asked now. Owners only. |
| Move | `POST /api/spaces/:spaceId/apps/:appId/move` | The entry goes to another space with its rows and the settings everyone shares, and so do the own settings, switches and pins of people who are in both spaces; those of everyone else are deleted. Access starts afresh: no exceptions, members get what the mover chooses (nothing by default), and a mover who is not an owner there keeps edit. Owners of the space it is in, into a space they own or may add apps to. |
| Delete data | `DELETE /api/spaces/:spaceId/apps/:appId/data` | Rows, settings, the entry and the app are deleted for good. Owners only, with the app's ID typed as confirmation, and only for an app that was removed or that the server holds no app for. |
| Switch and pin | `PATCH /api/spaces/:spaceId/apps/:appId/me` | The caller's own switch (`enabled`) and pin (`pinned`), nobody else's. Anyone who can see the app, view access included. Switching an app off hides it for that person only and changes no one's access. |

Whoever adds a built-in app to a group says what the other members get:
nothing (the default), view or edit. An app the chat makes is for its maker
and the space's owners until an owner chooses otherwise.

Who may use an app is one question with one answer,
`resolveInstall(db, registry, userId, spaceId, appId)`, which gives `"view"`,
`"edit"` or nothing:

- Nothing for someone who is not in the space, for an app the space does not
  have or that was removed from it, and for an app the server holds no app
  for.
- An owner of the space has edit. In a personal space that is its one member.
- A member has the exception an owner made for them, or else what the app
  gives every member; "none" is nothing.

"Nothing" is answered with `404 not_found` on every route about that app, so
none of the reasons can be told apart, and the session lists only apps with
an answer. The session and `resolveInstall` read the same SQL.

An install whose app the server does not hold, such as one of an old
mini-app that could not move to its built-in app, disappears from every
session, and its data is left exactly as it was until an owner deletes it.

## What an app's page can do

An app's page runs in an iframe whose sandbox gives it an origin of its
own, under a Content-Security-Policy that lets it load and send nothing
(`docs/platform.md`, "The sandbox"). It cannot read Hearth's pages, cookies
or storage, nor call Hearth's API. All it can do is ask the page around it,
through `window.hearth`: read and change the rows of its own collections,
read and save its settings, fetch from the hosts its manifest names, and
hear that its data changed. The page around it
(`packages/web/src/made/frame.tsx`) answers that iframe alone, always for
the app and space it drew it for, whatever a message says, by calling the
server with the person's sign-in.

On the server the same steps hold for every app's rows:

1. One database transaction, which first asks `resolveInstall` what this
   person may do. Nothing is `404`; a write with view only is `403`.
2. The row is checked against the collection's fields as the manifest
   declares them; one that does not fit is `400`, with the reason.
3. The store reads or writes, and is closed when the work returns.

The scoping rule of the whole project, every row belongs to a space, is
kept by what a page is *not* given: nothing it sends names a space, an app
or a person. The store is built by the server from the space and app in
the address and the signed-in person, after the access check, and every
statement it runs carries that space, that app and the collection's name
(`packages/server/src/apps/store.ts`, the only file with SQL for app data).
A row ID from another space is "not found". A store for reading has no
methods that write. The store stops working when the work returns, so
nothing can be read or written outside the transaction that checked access.

Rows are JSON documents, checked against the collection's schema when
written and again when read. There are no migrations for app data: a change
to an app must leave every stored row fitting its fields, or it is refused,
with the rows and why. A stored row that no longer fits fails the read,
with the app, the collection and the row in the server's log.

A page fetches through the server (`hearth.fetch`), and only from the hosts
its manifest lists, which only a built-in app does.
`packages/server/src/apps/fetch.ts` holds every request to the same rules
before it goes out: GET over https, on the default port, to a host the
manifest lists exactly; `User-Agent: Hearth` and a few headers that carry
nothing of anyone's, so no cookie and no `authorization`; redirects only
while they stay on https and the same host; 20 seconds and 2 MiB for an
answer. Requests to one host start at least 6.5 seconds apart across the
whole server, which keeps every space's apps together within GitHub's 10
searches a minute for an address without a token. A server sends them with
Node's own `fetch`; for end-to-end tests, `HEARTH_FETCH_STANDINS` names a
file of stand-in answers instead, which only a server in dev mode accepts,
so that no test reaches the network.

No app runs by itself: Hearth has no scheduled jobs. GitHub Trending
refreshes its lists from the browser of someone who may edit it, when they
open it and the lists are more than an hour old, or press "Refresh now".

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
  the database when an app is added, so a default can change with the app.
- A value saved under a name the manifest no longer declares is not read.
  It is not deleted either: saving replaces the named values and leaves the
  rest, so an app taken back to an earlier version finds its values again.
- A saved value that no longer fits its setting, such as an option that is
  gone, reads as the default. A multi-select keeps the options that remain.

What a setting declares (`maxLength`, `min`, `max`, `step`, the options,
`maxItems`) is the rule for its default and for every value saved in it;
one function in the SDK checks both. A number with a `step` is `min` (or 0)
plus a whole number of steps, as in a form's number field.

An app's page reads the same values, in one object by name, with
`hearth.settings()`, and saves them with `hearth.saveSettings()`, through
the same routes and rules.

## How the shell draws an app

The dashboard has a card for each app the session lists and the person has
switched on, in the size its manifest asked for. The shell draws the card's
frame: icon, name, the group's tag, the settings button and "Open". Inside
it is the app's page in its sandbox, told that it is drawn small
(`hearth.view` is `"card"`); at `/apps/:spaceId/:appId` (and anything below
it, for later) the shell draws the top bar and the same page whole below it
(`"page"`). The frame is as tall as the page says it is, within limits.

The page gets the theme's colours as CSS variables, the reader's language
and theme, and who is reading; it is drawn afresh when the app changes,
since the session carries its version. Nothing is pushed: a page reads its
rows again every so often (the built-in apps every 15 seconds), and when
another page of the same app on the screen, or the chat, has written. A
`not_found` from an app's settings means it is no longer there for this
person (removed or moved, or access taken away), so the session is loaded
again and the card goes.

## The Apps page and the settings dialog

The Apps page (`packages/web/src/pages/apps.tsx`) lists every app the
session lists, by space, those switched off included, so that they can be
switched on again. "Pinned" at the top holds shortcuts to the pinned ones,
and pinned apps come first on the dashboard, in the sidebar and in each
space's list. Each row has the person's own pin and switch, the app's
settings and, for an owner of the space, "Remove", which asks first and
says that the data is kept, and "Move" where there is somewhere to move it:
another space where the person may add apps. The move dialog says what goes
along and, from a group, who loses the app; afterwards the space it went to
says so and takes the focus. Where the person may add apps, "Add an app"
offers the built-in apps that the space does not have, or says why there
are none and points to the chat, where every other app is made. Adding an
app to a group, and moving one into a group, asks who else may use it,
"only me for now" first. A built-in app the space removed is offered too:
for an owner the dialog reads the space's owners' list first and says that
adding it again brings back its data, with how many entries, and its button
says "Bring back". A built-in app whose manifest lists hosts in `network`
is said to fetch data from them on its own ("Fetches data from
api.github.com on its own."), new or brought back; the dialog asks nothing
more about it. Whatever the server answers to adding, removing or moving,
the session and the owners' list are loaded again, so a page that was out
of date catches up. The page is "Apps" in the sidebar and in the phone's
tab bar, and the empty dashboard and the group cards link to it.

The settings dialog (`packages/web/src/apps/settings-dialog.tsx`) opens
from the Apps page, from the button on the app's card and from the top bar
of its page. It draws one control per setting from the manifest: a text box,
a number box with its limits in words, a switch, a row of choices, chips for
a multi-select, and an editable list. "For everyone in this space" holds the
space's settings, read-only for someone who may only view; "Only for you"
holds the reader's own. Saving sends only the values that were changed, and
the app's pages on the screen are told to read their settings again.

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
  settings in the group, and their conversations with their model there;
  the rows they wrote stay with the group.
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

The database has no table per app. `space_apps` says which app is in which
space; every other table about apps refers to it by space and app together:

| Table | Holds |
|---|---|
| `space_apps` | An app added to a space, what its members get by default, and when it was removed. Removing keeps the data. |
| `made_apps` | An app made in Hearth: its manifest, its page, the version in use, and the built-in app it was added from. `made_app_versions` holds its versions. Deleting the app's entry deletes it. |
| `app_rows` | Every app's data, one JSON document per row. |
| `app_settings` | Settings values: one JSON object for the space and one per person. |
| `app_access` | An owner's exception for one member. |
| `app_prefs` | Each person's own switch and pin. |
| `app_jobs` | How the jobs of the mini-apps ran, until November 2026. Nothing writes it any more; the move of an old app's install deletes its rows. |
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

## The assistant

The assistant is each person's own model, which they save in Settings
("Your model") and talk to in the chat (`docs/platform.md`). It works in one
of the person's spaces at a time, as that person.

- **What it may do is the person's access, capped by the space.** Each
  space's owners choose Off (where every space starts), Read only or Read
  and change, on the Assistant card in Settings, and may leave apps out
  there; an owner can also switch an Off space to Read and change from the
  chat. `VISIBLE` works out the result beside the person's own access (its
  `assistant`), and every tool of the chat reaches an app through
  `resolveInstall` with `by: "assistant"`, inside the transaction that
  reads or writes. Making an app needs Read and change for the space.
- **The switches came with a connector for Claude** (section F of
  `docs/mini-app-contract.md`): Hearth answered Claude at `/mcp`, with the
  mini-apps' queries and mutations as its tools. The owner removed the
  connector in November 2026, since the chat does what it did; the
  switches stayed for the chat.

## Repositories

`hearth`, this one, is the whole of Hearth, and public. `hearth-data`
(private, the owner's content) is for later, and will lie beside it on the
server. The database file and secrets live in neither.

Until November 2026 a third, `hearth-stones` (public, one folder per
mini-app), lay beside them, and the deploy's `APPS_REPO` could name more
repositories of mini-apps, the owner's or anyone's, whose code ran inside
the server. Every app is now made in Hearth and kept in the database, so no
repository holds apps, and none needs to be trusted for them.

## Deployment

A timer on the server runs `deploy/hearth-deploy.sh` every minute. It fetches
`main` of the framework, and only when it moved builds a fresh release: the
framework at its new commit, in a folder of its own. The script then tries
the release on a spare port against a copy of the database, switches a
`current` link to it and restarts the service. If the build or the trial
fails, the old release keeps running untouched. If the new release fails as the live
service, the script goes back to the old release and puts the database back
as it was just before the switch, because an older build refuses a database
that a newer build has migrated. There is no self-hosted GitHub Actions
runner, because the repository is public. See
[self-hosting.md](self-hosting.md).

The copy of the script that is installed on the server only starts a run.
It fetches the framework, and when the newest commit's
`deploy/hearth-deploy.sh` differs from itself, it hands the whole run over
to that one, which the deploy user then runs from `state/deploy-script`.
So every commit is built, tried and switched to by its own deploy script,
also the commit that changes the script, and the installed copy is
installed once. That commit's code runs as the deploy user in the build
anyway, so its deploy script gains no right by this; the systemd units and
the polkit rule, which need root, are still installed by hand. A commit
whose deploy script is missing, empty or cannot be parsed is not deployed:
the installed copy does that run itself as far as the build. `SELF_UPDATE=off`
in the deploy's settings makes the installed copy do all the work itself.
What an installed copy counts on in every later version of the script, for
handing a run over and for the run it cannot hand over, is listed at the
top of the script.

Until November 2026 every release was also built with the mini-apps of
`hearth-stones` and of any other repository the deploy's `APPS_REPO`
named. A `deploy.conf` written then may still name it: the script ignores
it, fetches none of those clones, and says so once when it builds.

## Checks

`pnpm check` runs type checking, lint, unit tests and the deploy script's
tests; `pnpm e2e` runs the end-to-end tests. CI runs both on GitHub's own
runners, for every pull request and every push to `main`.

Type checking covers the four packages and, with its own `tsconfig.json`,
the `e2e` folder and the Playwright configuration. The SDK's types are
themselves under test: `packages/sdk/src/index.test.ts` states what a
manifest and its settings must be, and a wrong type there fails the type
check. The UI kit's unit tests run in the SDK, in a simulated browser. They
cannot see styles: the kit's classes are turned into a stylesheet by the
web app's build, and an end-to-end test (`e2e/shell.spec.ts`) checks that
they arrive.

The server's tests run against databases in memory, with made apps written
into them (`packages/server/src/apps/test-world.ts`) or made through the
routes, and with the built-in apps of `catalog`; the chat's tests play the
model themselves. `src/serve.test.ts` also starts the server as a whole
process. Nothing in them reaches a network.

The end-to-end tests build the web app and the server. Most of them run the
built web app against a stand-in for `/api` (`e2e/fixtures.ts`) that each
test tells what to answer. A few (`e2e/real-server.spec.ts`) run against
the real server, built once and started three times: one copy signed in as the
owner, one as a member of the owner's family and one as a stranger. The
owner's and the member's share one database file, so that one test can be
two people: the owner invites the member, chooses what she may do with an
app, and adds a built-in app whose page both use in its sandbox. Every copy
answers its apps' fetches from one file of stand-in answers that the tests
write (`HEARTH_FETCH_STANDINS`), so nothing reaches the network.

`pnpm test` also runs `deploy/tests/deploy.test.sh`, which drives the real
deploy script through a failed trial, a failed switch with the database put
back, and a restart that cannot be confirmed, using stand-ins for git, pnpm
and systemctl. It also tries a commit that fails to install or to build, and
a config file that still names `APPS_REPO`.
And it follows the runs that one copy of the script hands over to another:
a newer deploy script that deploys the commit which brought it, with one
fetch and under the lock; a commit whose script is missing or broken, which
is not deployed; settings that only a newer script knows; a fetch that
fails; a run that finds the lock taken, or is started as root. One of
these tests uses the real git, on a repository it makes up.

TypeScript is held at version 6 on purpose. The lint tooling
(`typescript-eslint`) does not yet support TypeScript 7; if TypeScript is
upgraded before it does, `eslint.config.js` warns that TypeScript files are
not being linted, and CI fails rather than skip them.
