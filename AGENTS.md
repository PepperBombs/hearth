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
| `hearth-apps` | public | mini-apps, one folder each |
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
  and `hearth-apps`, builds, and switches over only if the build succeeds. No
  self-hosted GitHub Actions runner, because the repositories are public.
- On phones the tab bar is Home, Apps, Search, Me.

## Build order

1. App shell, deployed behind Cloudflare Access.
2. Mini-app contract, storage, settings and shared UI components.
3. Template and scaffold command.
4. Grocery list mini-app.
5. Scheduler, then the GitHub trending mini-app.

## Layout and commands

| Folder | Holds |
|---|---|
| `packages/shared` | Types and schemas shared by server and web: the API contract. Change it first, then both sides. |
| `packages/server` | Hono server: config, SQLite and migrations, identity, membership, `/api` routes, static files. |
| `packages/web` | React app: shell, pages, quick switcher, themes, `src/i18n` (English and Chinese), `src/components/ui` (the future shared UI kit). |
| `e2e` | Playwright end-to-end tests (`playwright.config.ts` at the root). |
| `deploy` | Pull-based deploy script, systemd units, example config. Not yet tested on a real server. |
| `docs` | `architecture.md` and `self-hosting.md`. |

Commands, from the repository root (Node 22, pnpm 10):

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Run server (port 4310) and web dev server (port 5173) with sign-in switched off. |
| `pnpm check` | Type checking, lint and unit tests. Run before every push. |
| `pnpm build` | Build shared, web, then server. |
| `pnpm e2e` | End-to-end tests against the built app. Run `pnpm build` first. |
| `pnpm start` | Start the built server. |

Things that bite:

- TypeScript stays on version 6 until `typescript-eslint` supports 7.
- Every interface string goes in both `packages/web/src/i18n/en.ts` and
  `zh.ts`; a missing key is a type error.
- The server's Content-Security-Policy allows scripts from its own origin
  only: no inline scripts, no outside hosts, no outside fonts.
- Mini-apps do not exist yet. The session lists no apps; pages show empty
  states.
