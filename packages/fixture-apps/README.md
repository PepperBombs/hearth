# Fixture apps

Mini-apps that belong to the framework: its tests run against them, and the
scaffold command will copy one as the template for a new app. This folder has
the shape of a mini-apps repository such as `hearth-stones`: one folder per
app, named after the app's ID, each using only `@hearth/sdk`.

They are sample apps with sample data. Nobody's real app lives here.

| Folder | Holds so far |
|---|---|
| `checklist` | `manifest.ts` and `server.ts`: one collection, `items`, with a query that lists them and mutations that add one, tick one and clear the ticked ones. Its card and page arrive with the steps of [docs/mini-app-contract.md](../../docs/mini-app-contract.md) that build what they need. |

The server does not load these by itself. Its tests pass them to
`createApp({ apps })` (`FIXTURE_APPS` in `packages/server/src/testing.ts`).
A running server holds the apps its build was given, which is none until the
build pipeline for mini-apps exists.

`pnpm lint` applies the "a mini-app uses only the SDK" rule to every folder
here, and `pnpm typecheck` checks them.
