# Architecture

Hearth is one small server and one web app. This page describes the pieces
that exist today (the app shell) and the rules later steps build on.

## The pieces

| Folder | What it is |
|---|---|
| `packages/shared` | Types and schemas shared by server and web. This is the contract between them: change it first, then both sides. |
| `packages/server` | A Hono app on Node. Answers `/api`, serves the built web app for every other path, and keeps data in one SQLite file. |
| `packages/web` | A React single-page app built with Vite: sidebar, dashboard, phone tab bar, settings, quick switcher, themes, English and Chinese. |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The pull-based deploy script and service files. |

Mini-apps, their storage and the scheduler do not exist yet. The session
always lists no apps, and screens show empty states.

## Spaces and roles

Every piece of data belongs to exactly one space and records who created it.

- Each person has one **personal** space, which only they can see.
- A **group** space is a family or team. Its owner decides which members can
  see or edit each app in it, and who may add apps to it.
- An app is added to a space. Moving an app between a personal and a group
  space moves its data with it.

Today only personal spaces are created. Group spaces, invitations from the
interface and per-app access arrive with the mini-app contract.

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

Type checking covers the three packages and, with its own `tsconfig.json`,
the `e2e` folder and `playwright.config.ts`. `pnpm test` also runs
`deploy/tests/deploy.test.sh`, which drives the real deploy script through a
failed trial, a failed switch with the database put back, and a restart that
cannot be confirmed, using stand-ins for git, pnpm and systemctl.

TypeScript is held at version 6 on purpose. The lint tooling
(`typescript-eslint`) does not yet support TypeScript 7; if TypeScript is
upgraded before it does, `eslint.config.js` warns that TypeScript files are
not being linted, and CI fails rather than skip them.
