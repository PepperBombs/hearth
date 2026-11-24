# Hearth: notes for agents

Keep this file short, about 100 lines, and true. It is read at the start of
every session, so every line here is paid for each time. The details live in
`docs/notes/`, one file per area: read the one for what you touch, and write
what you learn there, as one line.

## What this is

Hearth is a platform for personal apps. One owner runs it on their own
server, and their family uses it too. Each person makes the apps they want
in a chat with their own model, or adds one that Hearth ships; an app is a
manifest and one HTML page, kept in the database and run in the browser's
sandbox (`docs/platform.md`). This repository is all of Hearth: public,
MIT. Beside it on the server lies `hearth-data` (private, the owner's
content, for later). The database file and secrets live in neither.

## Rules that must not be broken

- **Nothing personal in this repository**, in files, commit messages or pull
  requests: no real domain, email address, server path, or real data. Use
  `example.com` and sample data only.
- **No secrets in Git.** Secrets come from a config file on the server.
- **No app's code runs on the server.** An app's page runs in the browser's
  sandbox and reaches only its own rows, settings and hosts, through
  `window.hearth`.
- **Every row of data carries a space ID and the ID of the user who created
  it.** Never write a query that is not scoped to a space.
- **Every interface string exists in English and Simplified Chinese.**
  Content typed by users is never translated.
- **Discuss before large changes.** The owner agrees on direction first, and
  reviews work through pull requests into `main`.

## Decisions already made

- TypeScript throughout; React with Vite; a small Node server on Hono; SQLite; Tailwind CSS with shadcn/ui-style components.
- The look is "A · Clean": blue-grey surfaces, white cards with a hairline border, one blue accent, one icon colour per app.
- Cloudflare Access signs people in. The app has no login page; it verifies the signed identity header, behind one small interface.
- Adding an app to a space, or changing it, is a saved setting, with no redeploy.
- Deployment is pull-based: a timer on the server builds `main` of `hearth` and switches over only if the build succeeds.
- On phones the tab bar is Home, Apps, Search, Me.

## Where it stands

The first build order (`docs/mini-app-contract.md`, now the record) was
built and reviewed: the app shell, mini-apps written against the SDK and
built into each release from a second repository, the grocery list, jobs
with GitHub Trending, and a connector for Claude, whose switches stay and
now govern each person's model in the chat (each space's owners choose Off,
Read only or Read and change, and the apps it may use). Then the owner chose
the direction of `docs/platform.md`. Built: the chat, each person's model
and key, made apps on the dashboard, changes by chat as versions that can
be undone, and the built-in apps (`packages/server/catalog`): the grocery
list, Ideas and GitHub Trending, to which the installs of the old apps of
those names move at start-up. In November 2026 the owner removed the
connector, then the old framework: the SDK's server side and hooks,
`hearth-apps`, the sample apps, the build-time registry, jobs and the
deploy's mini-apps repositories. Then the app center (`docs/center.md`): a
made app published to a group, the center at `/center`, and copies that
people add and change in the chat; updates of copies come next.

## Layout

| Folder | Holds |
|---|---|
| `packages/shared` | The API contract: types and schemas for server and web. Change it first. |
| `packages/sdk` | `@hearth/sdk`: the manifest rules every app is checked against, and the UI kit the web app is drawn with. |
| `packages/server` | The Hono server: database, identity, `/api`, apps in spaces (`src/apps`), made apps (`src/made`), the built-in apps (`catalog`), the chat (`src/model`), the app center (`src/center`), groups, the assistant's switches. |
| `packages/web` | The React app: shell, pages, the sandbox's frame (`src/made`), `src/i18n` (English and Chinese). |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The deploy script, its tests, systemd units. |
| `docs` | `architecture.md`, `platform.md`, `self-hosting.md`, `mini-app-contract.md` (the record), `notes/`. |

## Commands (Node 22, pnpm 10, from the root)

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Server (4310) and web (5173), sign-in off. |
| `pnpm --filter @hearth/server exec vitest run <file>` | One test file; likewise `@hearth/web`, `@hearth/shared`, `@hearth/sdk`. While working, run the narrowest test that covers the change. |
| `pnpm check` | Everything: types, lint, unit tests, the deploy script's tests. CI runs it on every pull request. |
| `pnpm build`, then `pnpm e2e` | End-to-end tests of the built app. |

## Notes by area: read before you touch it

| File | About |
|---|---|
| `docs/notes/layout.md` | Every folder and command in full. |
| `docs/notes/server.md` | Access (`VISIBLE`), installs, the store, settings, groups, refusals, the process. |
| `docs/notes/web.md` | The web app: the session, lists and dialogs, the settings dialog, the UI kit, the two languages. |
| `docs/notes/e2e.md` | The Playwright tests and the servers they share. |
| `docs/notes/deploy.md` | The deploy script. Read all of it before changing one line. |
| `docs/notes/platform.md` | Apps made in Hearth: manifests, the sandbox, `hearth.fetch`, the built-in apps, the chat, each person's model and the assistant's switches. |
| `docs/notes/progress.md` | What was built, in what order. |

## What bites everywhere

- `deploy/hearth-deploy.sh` on `main` is live code: a server runs it about a minute after a merge.
- Nothing automated may reach an outside host, a real model or Cloudflare. Tests answer from stand-ins.
- Every interface string goes in both `packages/web/src/i18n/en.ts` and `zh.ts`; a missing key is a type error.
- Who may use an app is decided in one place, the SQL `VISIBLE` in `packages/server/src/apps/installs.ts`. Add no second one.
- SQL for an app's rows and settings lives in `packages/server/src/apps/store.ts` alone; a test reads the source.
- A migration must work on a copy of real data, where the deploy tries each release first. Never change one that has shipped; a table nothing writes any more (`app_jobs`) stays.
- A server may still hold installs keyed `grocery`, `ideas` or `trending`, of the old apps: `moveLegacyInstalls` (`packages/server/src/made/builtin.ts`) moves them to the built-in apps at every start. Keep it working.
- TypeScript stays on version 6 until `typescript-eslint` supports 7.
