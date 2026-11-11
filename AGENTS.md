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
each marked there once built. Built so far: step 1, the SDK package skeleton,
and step 2, the UI kit in the SDK.

## Layout and commands

| Folder | Holds |
|---|---|
| `packages/shared` | Types and schemas shared by server and web: the API contract. Change it first, then both sides. |
| `packages/sdk` | `@hearth/sdk`, what mini-apps are written against: `defineApp`, the manifest types, the lists of icon and colour names, `SDK_VERSION`. `@hearth/sdk/web` (`src/web`) is the UI kit, which the shell is built from too. `@hearth/sdk/manifest-schema` is the run-time check of a manifest, for the framework only. Imports no other Hearth package. |
| `packages/server` | Hono server: config, SQLite and migrations, identity, membership, `/api` routes, static files. |
| `packages/web` | React app: shell, pages, quick switcher, themes, `src/i18n` (English and Chinese), `src/styles` (the design tokens and the Tailwind theme). Its buttons, inputs, dialogs and so on come from `@hearth/sdk/web`; the card and the avatar in `src/components` are the shell's own. |
| `e2e` | Playwright end-to-end tests (`playwright.config.ts` at the root). |
| `deploy` | Pull-based deploy script, systemd units, polkit rule, example config. Not yet tested on a real server; `deploy/tests` runs the script against stand-ins for git, pnpm and systemctl. |
| `docs` | `architecture.md`, `self-hosting.md` and `mini-app-contract.md` (the agreed design for mini-apps and its build plan). |

Commands, from the repository root (Node 22, pnpm 10):

| Command | Does |
|---|---|
| `pnpm install` | Install dependencies. |
| `HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev` | Run server (port 4310) and web dev server (port 5173) with sign-in switched off. |
| `pnpm check` | Type checking (the four packages and `e2e`), lint, unit tests and the deploy script's tests. Run before every push. |
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
- Mini-apps do not exist yet. The session lists no apps; pages show empty
  states. Nothing reads a manifest yet either: the shell uses the SDK only for
  its icon and colour names and its UI kit.
- `SDK_VERSION` in `packages/sdk/src/index.ts` must equal `version` in
  `packages/sdk/package.json`; a unit test fails otherwise. Below 1.0, a
  breaking change to the SDK's types or to the manifest schema raises the
  minor version.
- The SDK's type tests (`expectTypeOf`, `@ts-expect-error` in
  `packages/sdk/src/index.test.ts`) fail in `pnpm typecheck`, not in the test
  runner.
- A manifest has two descriptions that must agree: the types in
  `packages/sdk/src/index.ts` and the schema in `manifest-schema.ts`. Change
  both. `@hearth/sdk` itself must keep importing nothing (it ends up in the
  web bundle with every manifest); zod stays in `manifest-schema.ts`.
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
