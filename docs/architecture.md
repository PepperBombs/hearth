# Architecture

Hearth is one small server and one web app. This page describes the pieces
that exist today (the app shell) and the rules later steps build on.

## The pieces

| Folder | What it is |
|---|---|
| `packages/shared` | Types and schemas shared by server and web. This is the contract between them: change it first, then both sides. |
| `packages/sdk` | `@hearth/sdk`, the only thing a mini-app imports. So far: `defineApp`, the manifest types, the run-time check of a manifest, and the UI kit (`@hearth/sdk/web`). It imports no other Hearth package. |
| `packages/server` | A Hono app on Node. Answers `/api`, serves the built web app for every other path, and keeps data in one SQLite file. `src/apps` holds the mini-apps this build was given and decides who may use which app in which space. |
| `packages/fixture-apps` | The framework's own sample mini-apps, which its tests run against. So far one manifest, `checklist`. |
| `packages/web` | A React single-page app built with Vite: sidebar, dashboard, phone tab bar, settings, quick switcher, themes, English and Chinese. It is built from the SDK's UI kit, as mini-apps will be. |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The pull-based deploy script and service files. |

Mini-apps are being built in steps. The server can already hold apps, add
one to a space, remove it, bring it back and delete its data (see "Apps in
spaces" below). It cannot run an app's code yet, the build does not hand it
any apps, and the web app shows none: on a running server the session still
lists no apps and screens show empty states. The scheduler does not exist.
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

## Apps in spaces

The server is built with a fixed list of mini-apps: the **registry**
(`packages/server/src/apps/registry.ts`). Code arrives with a deploy, never
at run time. At start-up every app's manifest is checked, and a bad one stops
the server before it opens the database, so the deploy's trial of a new
release fails and the old release keeps running.

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

## Where an app's data will live

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
and strings must come out as, and a wrong type there fails the type check.
The UI kit's unit tests run in the SDK, in a simulated browser. They cannot
see styles: the kit's classes are turned into a stylesheet by the web app's
build, and an end-to-end test (`e2e/shell.spec.ts`) checks that they arrive.
Lint also holds the fixture apps to the rule for every mini-app: import the
SDK and your own files, nothing else.
`pnpm test` also runs `deploy/tests/deploy.test.sh`, which drives the real
deploy script through a failed trial, a failed switch with the database put
back, and a restart that cannot be confirmed, using stand-ins for git, pnpm
and systemctl.

TypeScript is held at version 6 on purpose. The lint tooling
(`typescript-eslint`) does not yet support TypeScript 7; if TypeScript is
upgraded before it does, `eslint.config.js` warns that TypeScript files are
not being linted, and CI fails rather than skip them.
