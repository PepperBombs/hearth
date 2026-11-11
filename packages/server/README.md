# @hearth/server

The Hearth server: a small [Hono](https://hono.dev) application on Node that
answers the JSON API under `/api` and serves the built web app for every other
path. It keeps its data in one SQLite file.

It is the app shell plus the first parts of mini-apps: the server is built
with a list of apps; an app can be added to a space, removed, brought back
and its data deleted; and an app's own queries and mutations run against
rows that belong to one app in one space (see "Mini-apps"). The build does
not hand the server any apps yet, so a running server's session still lists
`apps: []`.

## Run it in development

From the repository root:

```sh
HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm --filter @hearth/server dev
```

This starts the server on `http://127.0.0.1:4310` and restarts it when a file
changes. `HEARTH_AUTH=dev` switches sign-in off: every request is treated as
`HEARTH_DEV_USER` (by default the owner). The database is created at
`packages/server/data/hearth.db`, which Git ignores.

Because nobody is asked who they are, a server in this mode answers only
requests addressed to this machine itself: the `Host` header must name
`localhost`, `127.0.0.1` (any `127.x.x.x`) or `::1`. Everything else gets
`403`, pages included, and so does a request that carries a proxy's headers
(`X-Forwarded-For`, `Cf-Connecting-Ip` and the like). Open it as
`http://localhost:5173` or `http://127.0.0.1:4310`, not under another name.

The web app has its own dev server, which passes `/api` on to this one.
`pnpm dev` at the repository root starts both; give it the same two variables.

To see what a person who has not been invited sees, set `HEARTH_DEV_USER` to
another address, for example `HEARTH_DEV_USER=guest@example.com`.

## Run it for real

```sh
pnpm build        # at the repository root: shared, then web, then server
HEARTH_CONFIG=/path/to/hearth.json pnpm start
```

`pnpm start` runs `node dist/main.js` in this package. The server listens on
`127.0.0.1` and expects Cloudflare Access (through a tunnel on the same
machine) in front of it. It stops cleanly on `SIGINT` and `SIGTERM`.

## Settings

Settings are environment variables. They may also be put in a JSON file named
by `HEARTH_CONFIG`, using the same names as keys; a variable set in the
environment wins over the file. An empty value counts as not set. If anything
is missing or wrong, the server prints what and exits before listening.

| Setting | Default | Meaning |
|---|---|---|
| `HEARTH_CONFIG` | none | Path of a JSON file of settings. Environment only. |
| `HOST` | `127.0.0.1` | Address to listen on. Leave it on loopback unless something on another machine must connect. An IPv6 address may be written with or without brackets (`::1` or `[::1]`). |
| `PORT` | `4310` | Port to listen on. |
| `HEARTH_DB` | `./data/hearth.db` | Path of the SQLite file. Its folder is created if needed. A folder or file created here is readable by the server's own account only. |
| `HEARTH_APPS_DIR` | none | Folder of the `hearth-stones` checkout. Stored for a later step; not used yet. |
| `HEARTH_DATA_DIR` | none | Folder of the `hearth-data` checkout. Stored for a later step; not used yet. |
| `HEARTH_WEB_DIST` | `../web/dist`, from this package | Folder holding the built web app. |
| `HEARTH_AUTH` | `cloudflare-access` | How requests are identified: `cloudflare-access` or `dev`. |
| `HEARTH_CF_TEAM_DOMAIN` | none | Required for `cloudflare-access`. The Access team domain, for example `your-team.cloudflareaccess.com`. |
| `HEARTH_CF_AUDIENCE` | none | Required for `cloudflare-access`. The Application Audience (AUD) tag of the Access application. |
| `HEARTH_OWNER_EMAIL` | none | Required. The owner's email address. This person is let in without an invitation. |
| `HEARTH_DEV_USER` | the owner | The email address every request is treated as when `HEARTH_AUTH=dev`. |
| `HEARTH_VERSION` | `dev` | Shown as the running version; the deploy sets it to the short commit hash. |

Relative paths are resolved against the working directory, except the default
for `HEARTH_WEB_DIST`. Started through pnpm (`pnpm start`, `pnpm --filter
@hearth/server dev`), the working directory is this package's folder, so the
default database is `packages/server/data/hearth.db`. On a server, give
`HEARTH_DB` an absolute path outside the checkout. `HEARTH_AUTH=dev` is refused unless `HOST` is a loopback
address (`127.0.0.1`, `::1` or `localhost`).

A config file looks like this:

```json
{
  "HEARTH_OWNER_EMAIL": "you@example.com",
  "HEARTH_CF_TEAM_DOMAIN": "your-team.cloudflareaccess.com",
  "HEARTH_CF_AUDIENCE": "0123456789abcdef",
  "HEARTH_DB": "/var/lib/hearth/hearth.db"
}
```

It holds no secrets at this step, but later ones will add some: keep it out of
Git and readable only by the account that runs the server.

## Who gets in

The server has no login page. "Who is this request from?" is one function,
`Identify` in `src/auth/identify.ts`, with two implementations:

- `cloudflareAccess` verifies the JWT that Cloudflare Access adds to each
  request (the `Cf-Access-Jwt-Assertion` header, or else the `CF_Authorization`
  cookie) against the team's published keys, checks its issuer, audience and
  expiry, and takes the email address from it. Plain headers that merely state
  an email address are never read.
- `dev` answers with the configured address, unchecked.

An address has one spelling: it is trimmed, lower-cased, and accented letters
are put in composed form (NFC), so the same mailbox is the same person however
the identity provider writes it. An address with a character outside ASCII
that stands for an ASCII one, such as the Kelvin sign (which lower-cases to
"k") or a full-width letter, is not accepted at all: it would otherwise be
taken for someone else's address. `normaliseEmail` in `src/email.ts` is the
one place this is decided.

Then, for the verified address:

- A known user is let in.
- The owner is created on first sight, with a personal space.
- Someone with a row in the `invitations` table is created on first sight, with
  their own personal space, and the row is removed.
- Anyone else gets `403` with the code `not_a_member`.

A request with no valid identity gets `401` with the code `unauthenticated`.
There is no screen or route for inviting people yet; `addInvitation` in
`src/db/people.ts` is what a later step will call.

A new user's language comes from the `Accept-Language` header (Chinese if it
ranks Chinese above English, otherwise English), their theme is `system`, and
their name is the part of the address before the `@`. They can change all
three.

## API

The shapes are defined in `@hearth/shared`, which is the contract with the web
app.

| Route | Sign-in | Answer |
|---|---|---|
| `GET /api/health` | no | `{ ok: true, version }` |
| `GET /api/session` | yes | The user; their spaces, each with their role, whether they may add apps, and its members (ID, name and role, no email address); `apps`, every app they can use in every space they are in; `canCreateGroups` and `canInvitePeople`, both `false` until groups are built; and the version. |
| `PATCH /api/me` | yes | Takes any of `name`, `locale`, `theme`; answers with the updated user. |
| `PUT /api/spaces/:spaceId/apps/:appId` | yes | Adds the app to the space, or brings a removed one back with its data. Takes `{ memberAccess? }`. Answers `204`. |
| `DELETE /api/spaces/:spaceId/apps/:appId` | yes | Removes the app from the space and keeps its data. Answers `204`. |
| `DELETE /api/spaces/:spaceId/apps/:appId/data` | yes | Deletes the data of a removed app for good. Takes `{ confirm }`, the app's ID. Answers `204`. |
| `POST /api/spaces/:spaceId/apps/:appId/q/:name` | yes | Runs the app's query of that name. Takes `{ input? }`; answers `{ output }`. Needs view access. |
| `POST /api/spaces/:spaceId/apps/:appId/m/:name` | yes | Runs the app's mutation of that name. Takes `{ input? }`; answers `{ output }`, or `{}` when it returns nothing. Needs edit access. |

Every failure has the shape `{ error: { code, message } }`. The message is
English text for logs and network traces; the web app chooses what to show
from the code. Unknown routes under `/api` answer `404` with `not_found`. An
unexpected failure answers `500` with `internal` and no detail; the detail goes
to the server's log. `forbidden` (403) is for a member who may not do this,
and `conflict` (409) for a request that cannot be carried out as things
stand. The contract also holds the requests of routes that are not built yet:
groups, members, access, moving an app and settings
(`docs/mini-app-contract.md`, section A8).

## Mini-apps

The code is in `src/apps`; the design is `docs/mini-app-contract.md`.

**The registry.** `createApp({ config, db, apps })` is given the mini-apps
this build holds, each as `{ id, manifest, hasPage, server? }`. It checks
every manifest against the SDK's schema, that `id` equals the manifest's
`id`, and that no ID comes twice. It also checks what an app's `server.ts`
exports (`src/apps/definition.ts`): that it was made with `defineServer` and
this app's manifest, that every query and mutation has a description, and
that the names of routes, collections and fields are plain and no field is
called like one of the fields every row has. If anything is wrong the server
prints every problem and exits with status 1, before it opens the database
or listens. `main.ts` passes an empty list for now: writing the list from
the apps folders is a later step.
The tests pass the sample apps in `packages/fixture-apps`.

**An app in a space** is a row in `space_apps`.

- `PUT .../apps/:appId` adds it. The person must be an owner of the space or
  a member allowed to add apps (`403` otherwise; `404` if they are not in the
  space or the server holds no such app). `memberAccess` is what the other
  members of a group get: `none` (the default), `view` or `edit`. A member
  who adds an app gets edit for themselves. `409` if the app's manifest does
  not allow this kind of space.
- The same `PUT` on an app that is already there changes nothing and answers
  `204`; asking for a different `memberAccess` answers `409`.
- `DELETE .../apps/:appId` removes it: owners only (`403` for a member who
  can use the app, `404` for anyone it is hidden from). Nothing is deleted.
- The same `PUT` on a removed app brings it back with its rows, settings and
  everyone's switches and pins. Owners only, and access starts afresh:
  `memberAccess` as given now, and no exceptions from before. A member who
  may add apps gets `409` for an app the space has an entry for that they
  cannot see.
- `DELETE .../apps/:appId/data` deletes the rows, the settings and the entry
  for good. Owners only (`403` for any other member), `confirm` must be the
  app's ID (`400`), and the app must have been removed or its code be gone
  (`409` otherwise).

**Who may use an app** is `resolveInstall` in `src/apps/installs.ts`: `null`,
`"view"` or `"edit"`. An owner of the space has edit; a member has their
exception in `app_access`, or else the app's `member_access`; `none`, a
removed app, an app without code and a space the person is not in are all
`null`, which every route about one app answers with `404`. The session lists
exactly the apps for which it is not `null`, from the same SQL.

**An app whose folder is gone** from a deploy disappears from every session
and answers `404`. Its rows are not touched, and it returns when the folder
does. An owner can delete its data without removing it first.

**An app's queries and mutations** are what its `server.ts` defines with
`@hearth/sdk/server`. `callApp` in `src/apps/calls.ts` runs one:

- Everything happens in one database transaction, the check of who is asking
  first: deferred for a query, immediate for a mutation. A change of access
  cannot land between the check and the handler, and what a mutation wrote
  is kept as a whole or not at all.
- `404` when `resolveInstall` gives `null`, when the app has no server file,
  and when it has no route of that name and kind: a mutation cannot be
  reached under `/q/`, nor a query under `/m/`.
- `403` `forbidden` for a mutation by someone who may only view, before
  anything is said about the input.
- `400` `invalid_request` when `input` does not fit the route's schema, when
  a route that takes none is sent some, and when a handler stores a value its
  collection's schema refuses.
- A handler turns a request down by throwing `AppError`: `400`, `404` or
  `409`, with its message. Anything else it does wrong is a fault, logged as
  `AppFaultError` with the app and the route and answered with `500`: an
  error it throws, a promise it returns (handlers are not `async`), an
  answer that is not JSON, a misuse of the store.
- The handler's `ctx` has the person (ID and name), their language, the
  space's kind and name, their access, the app's settings, the time and
  `db`. It has no space ID. `ctx.settings` holds the manifest's defaults
  until settings can be saved.

**The store** (`src/apps/store.ts`) is `ctx.db`: the app's collections, each
with `get`, `list` and `count`, and for a mutation also `insert`, `update`,
`remove` and `removeWhere`. A query's collections do not have the writing
methods at all.

- A store is made for one request from the space and app of the address and
  the signed-in person. Every statement it runs is limited to that space,
  that app and one collection, so a row of another space is simply not
  found. `created_by` and `updated_by` are the signed-in person.
- Rows are checked against the collection's zod schema when written and
  again when read. A stored row that no longer fits fails the read with a
  `StoredRowError` naming the app, the collection and the row.
- `where` takes fields of the collection and the text, number, switch or
  null each should equal; `orderBy` takes a field, `createdAt` or
  `updatedAt`. Anything else throws `StoreUsageError`, a fault of the app. A
  row stored before a field was added counts as holding that field's
  default, in `where` and `orderBy` as in what is read.
- `list` gives at most 1000 rows unless `limit` says otherwise, and never
  more than 5000.
- The store is closed when the handler returns and refuses everything from
  then on, so nothing is read or written outside the transaction that
  checked access.

A unit test (`src/apps/store-boundary.test.ts`) fails when a source file
other than `store.ts` and the migrations names `app_rows` or `app_settings`,
or when a statement in `store.ts` does not name its space and app.

## Web app files

Every `GET` outside `/api` is answered from `HEARTH_WEB_DIST`:

- A file under `/assets/` (where Vite puts files with a content hash in their
  name) may be kept by browsers for a year. If it does not exist the answer is
  `404`.
- Pictures and fonts elsewhere are kept for an hour.
- Everything else (`index.html`, `sw.js`, the web manifest, any script or
  style sheet without a hash) is sent with `Cache-Control: no-cache`, so the
  browser asks every time and usually gets a short `304`.
- Any other path gets `index.html`, so client-side routes survive a reload.
- Hidden files, and anything outside the folder, are never served.

If the folder or its `index.html` is missing, `/` and every other page answer
`503` with a short text saying so, in both languages; the API keeps working.
The folder is looked at on each request, so building the web app later needs
no restart. Files are not compressed here; Cloudflare
does that.

## Protections

- Every response carries a Content-Security-Policy that allows scripts, fonts,
  images and connections from the server itself only, forbids inline scripts
  and forbids framing, together with `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. Inline styles
  are allowed, because interface libraries set them at run time. If a
  Cloudflare feature injects scripts into pages (Rocket Loader, email address
  obfuscation, Web Analytics), this policy blocks them: switch those off for
  the site.
- A request under `/api` that is not a `GET` or `HEAD` is refused with `403`
  if its `Origin` header names a different host from its `Host` header. The
  proxy in front must therefore pass the original `Host` on, as a Cloudflare
  tunnel does by default. With `HEARTH_AUTH=dev`, origins on the same machine
  at another port are also accepted, so the web dev server works however it
  proxies.
- With `HEARTH_AUTH=dev`, every request must be addressed to a loopback name
  and must not have passed through a proxy; see "Run it in development".
  Listening on loopback alone would not stop a web page that points its own
  host name at `127.0.0.1` (DNS rebinding), nor a tunnel on the same machine.
- Answers under `/api` are sent with `Cache-Control: no-store`.
- Request bodies over 64 KB are refused.

## Database

SQLite through `better-sqlite3`, in WAL mode with foreign keys on. The schema
is a list of numbered migrations in `src/db/migrations.ts`; the ones that have
run are recorded in the `migrations` table and the rest are applied at
start-up, each in its own transaction. Add a new migration with the next
number; never change one that has shipped. The server refuses to start on a
database that a newer build has migrated.

Tables so far, from migration 1: `users`, `spaces`, `space_members`,
`invitations`. Migration 2 adds the tables of the mini-app contract:
`space_apps` (an app added to a space), `app_rows` (every mini-app's data),
`app_settings`, `app_access`, `app_prefs` and `space_invitations`, plus the
column `space_members.can_add_apps`. The server writes `space_apps` and, for
a member who adds an app, `app_access`; an app's mutations write `app_rows`
through the store; all of them are deleted from when an app's data is
deleted. Nothing writes settings, switches or invitations yet. SQL for
`app_rows` and `app_settings` lives in `src/apps/store.ts` only.

Rules the database keeps by itself, tested as SQL in
`src/db/apps-schema.test.ts`:

- Every table with a `space_id` and an `app_id` refers to `space_apps` with
  `ON UPDATE CASCADE`, so an app moves to another space with one `UPDATE`. A
  new table of that kind needs the same key; a test fails without it.
- `app_rows` and `app_settings` use `ON DELETE RESTRICT`: delete them first,
  on purpose, then the `space_apps` row.
- A space keeps at least one owner. Three triggers on `space_members` refuse
  a first member who is not an owner, and refuse to remove or demote the last
  owner. They fail with `SQLITE_CONSTRAINT_TRIGGER`.

Back the database up with SQLite's own backup command, not by copying the
file while the server runs.

The file holds everyone's data. When the server creates it, the file is
readable and writable by the server's account only (mode 600), in a folder
only that account can enter (700) if the server created the folder too.
SQLite gives the `-wal` and `-shm` files beside it the same permissions. A
file or folder that already exists is left as it is.

## Commands

```sh
pnpm --filter @hearth/server dev        # run from source, restarting on change
pnpm --filter @hearth/server typecheck
pnpm --filter @hearth/server test
pnpm --filter @hearth/server build      # writes dist/main.js
pnpm --filter @hearth/server start      # runs dist/main.js
```

The tests need no network and no settings: they use in-memory databases,
temporary folders, and a key pair generated on the spot for the Cloudflare
Access verifier.
