# Hearth: notes for agents

Keep this file short, about 100 lines, and true. It is read at the start of
every session, so every line here is paid for each time. The details live in
`docs/notes/`, one file per area: read the one for what you touch, and write
what you learn there, as one line.

## What this is

Hearth is a framework for personal mini-apps. One owner runs it on their own
server; later their family uses it too. This repository is the framework and
its SDK: public, AGPL-3.0. Three repositories are checked out side by side on
the server: `hearth` (this one), `hearth-stones` (public, the mini-apps, one
folder each) and `hearth-data` (private, the owner's content). The database
file and secrets live in none of them. Mini-apps need not live in
`hearth-stones`: the server's `APPS_REPO` may name more repositories of them.

## Rules that must not be broken

- **Nothing personal in this repository**, in files, commit messages or pull
  requests: no real domain, email address, server path, or real data. Use
  `example.com` and sample data only.
- **No secrets in Git.** Secrets come from a config file on the server.
- **A mini-app uses only the SDK**, never framework internals or another
  mini-app. An automated check enforces it.
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
- Adding an app to a space is a saved setting, with no redeploy.
- Deployment is pull-based: a timer on the server builds `main` of `hearth` and of every mini-apps repository it names (`hearth-stones` first) and switches over only if the build succeeds.
- On phones the tab bar is Home, Apps, Search, Me.

## Where it stands

All six items of the build order are built and reviewed: the app shell, the
mini-app contract (SDK, storage, settings, UI kit), the scaffold command, the
grocery list, scheduled jobs with GitHub Trending, and the assistant (Hearth
as a connector for Claude, at `POST /mcp`). The design, the owner's decisions
and each step's as-built notes are in `docs/mini-app-contract.md`. Not yet
tried on a real server: the assistant against the real Claude and
Cloudflare's Managed OAuth (`docs/self-hosting.md`, section 10).

## Layout

| Folder | Holds |
|---|---|
| `packages/shared` | The API contract: types and schemas for server and web. Change it first. |
| `packages/sdk` | `@hearth/sdk`, what mini-apps are written against; the UI kit; the `hearth-apps` command. |
| `packages/server` | The Hono server: database, identity, `/api`, mini-apps (`src/apps`), groups, the assistant. |
| `packages/fixture-apps` | Sample mini-apps for tests; `checklist` is the template for new apps. |
| `packages/web` | The React app: shell, pages, `src/i18n` (English and Chinese). |
| `e2e` | Playwright end-to-end tests. |
| `deploy` | The deploy script, its tests, systemd units. |
| `docs` | `architecture.md`, `self-hosting.md`, `mini-app-contract.md`, `notes/`. |

## Commands (Node 22, pnpm 10, from the root)

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Server (4310) and web (5173), sign-in off. `HEARTH_APPS_DIR=packages/fixture-apps` adds the sample apps. |
| `pnpm --filter @hearth/server exec vitest run <file>` | One test file; likewise `@hearth/web`, `@hearth/shared`, `@hearth/sdk`. While working, run the narrowest test that covers the change. |
| `pnpm check` | Everything: types, lint, unit tests, the deploy script's tests. CI runs it on every pull request. |
| `pnpm build`, then `pnpm e2e` | End-to-end tests of the built app. |
| `pnpm e2e:mini-apps` | End-to-end tests of the apps in `../hearth-stones`. |

## Notes by area: read before you touch it

| File | About |
|---|---|
| `docs/notes/layout.md` | Every folder and command in full. |
| `docs/notes/server.md` | Access (`VISIBLE`), installs, calls, the store, settings, groups, refusals. |
| `docs/notes/jobs.md` | Jobs, the scheduler, `ctx.fetch`, stand-ins. |
| `docs/notes/mini-apps.md` | The SDK, `hearth-apps`, the sample apps, an app's own tests. |
| `docs/notes/web.md` | The web app: the session, lists and dialogs, the two languages. |
| `docs/notes/e2e.md` | The Playwright tests and the servers they share. |
| `docs/notes/deploy.md` | The deploy script. Read all of it before changing one line. |
| `docs/notes/assistant.md` | The MCP endpoint, its tools, the Assistant card. |
| `docs/notes/progress.md` | What was built, in what order. |

## What bites everywhere

- `deploy/hearth-deploy.sh` on `main` is live code: a server runs it about a minute after a merge.
- Nothing automated may reach an outside host, the real Claude or Cloudflare. Tests answer from stand-ins.
- Every interface string goes in both `packages/web/src/i18n/en.ts` and `zh.ts`; a missing key is a type error.
- Who may use an app is decided in one place, the SQL `VISIBLE` in `packages/server/src/apps/installs.ts`. Add no second one.
- SQL for an app's rows and settings lives in `packages/server/src/apps/store.ts` alone; a test reads the source.
- A migration must work on a copy of real data, where the deploy tries each release first. Never change one that has shipped.
- A plain `pnpm build` holds no mini-apps: `HEARTH_APPS_DIR` decides at build time. `pnpm e2e` leaves the sample apps in both `dist` folders.
- TypeScript stays on version 6 until `typescript-eslint` supports 7.
