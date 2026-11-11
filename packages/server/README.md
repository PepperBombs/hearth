# @hearth/server

The Hearth server: a small [Hono](https://hono.dev) application on Node that
answers the JSON API under `/api` and serves the built web app for every other
path. It keeps its data in one SQLite file.

It is the app shell plus most of mini-apps: the server is built with a
list of apps; an app can be added to a space, removed, brought back, moved
with its data to another space and its data deleted; an app's own queries
and mutations run against rows that
belong to one app in one space (see "Mini-apps"); and groups can be created,
people added to them or invited, and their owners decide who can use each
app (see "Groups and members"). Which apps a server holds is decided when it
is built (`HEARTH_APPS_DIR`, read by `pnpm build` and `pnpm dev`, not by the
running server); built without it, a server holds none and its session lists
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

`HEARTH_APPS_DIR` is not one of them. It names the folders of mini-apps for
the build (see "Mini-apps"), and the running server does not read it. A
config file that still has it is accepted, and the value ignored.

| Setting | Default | Meaning |
|---|---|---|
| `HEARTH_CONFIG` | none | Path of a JSON file of settings. Environment only. |
| `HOST` | `127.0.0.1` | Address to listen on. Leave it on loopback unless something on another machine must connect. An IPv6 address may be written with or without brackets (`::1` or `[::1]`). |
| `PORT` | `4310` | Port to listen on. |
| `HEARTH_DB` | `./data/hearth.db` | Path of the SQLite file. Its folder is created if needed. A folder or file created here is readable by the server's own account only. |
| `HEARTH_DATA_DIR` | none | Folder of the `hearth-data` checkout. Stored for a later step; not used yet. |
| `HEARTH_WEB_DIST` | `../web/dist`, from this package | Folder holding the built web app. |
| `HEARTH_AUTH` | `cloudflare-access` | How requests are identified: `cloudflare-access` or `dev`. |
| `HEARTH_CF_TEAM_DOMAIN` | none | Required for `cloudflare-access`. The Access team domain, for example `your-team.cloudflareaccess.com`. |
| `HEARTH_CF_AUDIENCE` | none | Required for `cloudflare-access`. The Application Audience (AUD) tag of the Access application. |
| `HEARTH_OWNER_EMAIL` | none | Required. The owner's email address. This person is let in without an invitation. |
| `HEARTH_DEV_USER` | the owner | The email address every request is treated as when `HEARTH_AUTH=dev`. |
| `HEARTH_GROUP_POLICY` | `owner` | Who may create groups and invite people who are not on the server yet: `owner`, the server's owner alone, or `everyone` on the server. Adding someone who is already on the server to a group is for that group's owners either way. |
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
  their own personal space, and the row is removed. In the same transaction
  they join every group that invited them (`space_invitations`), with the
  role and the right to add apps each invitation names.
- Anyone else gets `403` with the code `not_a_member`.

A request with no valid identity gets `401` with the code `unauthenticated`.
People are invited by adding their address to a group (see "Groups and
members"), which writes both rows. A row in `space_invitations` alone lets
nobody in.

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
| `GET /api/session` | yes | The user; their spaces, each with their role, whether they may add apps, and its members (ID, name and role, no email address); `apps`, every app they can use in every space they are in; `canCreateGroups` and `canInvitePeople`, from `groupRights` (see "Groups and members"); and the version. |
| `PATCH /api/me` | yes | Takes any of `name`, `locale`, `theme`; answers with the updated user. |
| `POST /api/spaces` | yes | Creates a group with the caller as its owner. Takes `{ name }`; answers `201` with the space as the session lists it. |
| `PATCH /api/spaces/:spaceId` | yes | Renames a group: `{ name? }`. Owners only. Answers `204`. |
| `POST /api/spaces/:spaceId/members` | yes | Adds someone by address: `{ email, role?, canAddApps? }`. Answers `{ outcome: "added" }` for someone on the server, `{ outcome: "invited" }` for anyone else. Owners only. |
| `PATCH /api/spaces/:spaceId/members/:userId` | yes | A member's `role` or `canAddApps`. Owners only. Answers `204`. |
| `DELETE /api/spaces/:spaceId/members/:userId` | yes | Removes a member: an owner removing anyone, or anyone leaving. Answers `204`. |
| `DELETE /api/spaces/:spaceId/invitations` | yes | Takes back an invitation: `{ email }`. Owners only. Answers `204`. |
| `GET /api/spaces/:spaceId/apps` | yes | The owners' list: every app the space has (removed ones and those without code included) with its row count, what members get and the exceptions; everyone in the space with their address and right to add apps; the invitations. Owners only. |
| `PUT /api/spaces/:spaceId/apps/:appId/access` | yes | Who can use the app: `{ memberAccess?, members? }`, exceptions by user ID, `null` removing one. Owners only. Answers `204`. |
| `PUT /api/spaces/:spaceId/apps/:appId` | yes | Adds the app to the space, or brings a removed one back with its data. Takes `{ memberAccess? }`. Answers `204`. |
| `DELETE /api/spaces/:spaceId/apps/:appId` | yes | Removes the app from the space and keeps its data. Answers `204`. |
| `POST /api/spaces/:spaceId/apps/:appId/move` | yes | Moves the app with its data to another space: `{ toSpaceId, memberAccess? }`. Owners of the space it is in, into a space they own or may add apps to. Answers `204`. |
| `DELETE /api/spaces/:spaceId/apps/:appId/data` | yes | Deletes the data of a removed app for good. Takes `{ confirm }`, the app's ID. Answers `204`. |
| `PATCH /api/spaces/:spaceId/apps/:appId/me` | yes | The caller's own switch and pin for the app: `{ enabled?, pinned? }`. Answers `204`. Needs view access. |
| `GET /api/spaces/:spaceId/apps/:appId/settings` | yes | The app's settings in this space: `{ space, user }`, the values everyone shares and the caller's own, defaults filled in. Needs view access. |
| `PATCH /api/spaces/:spaceId/apps/:appId/settings` | yes | Saves the settings named in `{ space?, user? }`; answers like the `GET`. `space` needs edit access, `user` only view. |
| `POST /api/spaces/:spaceId/apps/:appId/q/:name` | yes | Runs the app's query of that name. Takes `{ input? }`; answers `{ output }`. Needs view access. |
| `POST /api/spaces/:spaceId/apps/:appId/m/:name` | yes | Runs the app's mutation of that name. Takes `{ input? }`; answers `{ output }`, or `{}` when it returns nothing. Needs edit access. |

Every failure has the shape `{ error: { code, message } }`. The message is
English text for logs and network traces; the web app chooses what to show
from the code. Unknown routes under `/api` answer `404` with `not_found`. An
unexpected failure answers `500` with `internal` and no detail; the detail goes
to the server's log. `forbidden` (403) is for a member who may not do this,
and `conflict` (409) for a request that cannot be carried out as things
stand.

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
or listens.

`main.ts` takes the list from `src/apps/registry.generated.js`, which
`hearth-apps sync` writes before every build and before `pnpm dev` from the
folders named in `HEARTH_APPS_DIR` (one, or several separated like `PATH`;
`docs/architecture.md`, "How mini-apps get into a build"). The file is not
in Git; its types, `registry.generated.d.ts`, are. Nothing else imports it:
the tests pass the sample apps in `packages/fixture-apps` by hand
(`FIXTURE_APPS` in `src/testing.ts`). To run the server from source with
the sample apps:

```sh
HEARTH_APPS_DIR=packages/fixture-apps HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm dev
```

`src/apps/check-bundle.ts` is not part of the server. `hearth-apps check`
runs it to put a generated list through `createRegistry`, so that an app
which passes the check does not stop a server from starting.

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
- `POST .../apps/:appId/move` (`moveApp`) moves the app with its data to
  the space `toSpaceId` names, in one immediate transaction. The caller
  must own the space the app is in (`403` for a member who can use it,
  `404` for anyone it is hidden from, a removed app and one without code
  included) and own the other space or be allowed to add apps there (`404`
  when they are not in it or it does not exist, `403` for a plain member).
  `409` when the manifest does not allow that kind of space, and when that
  space has an entry for the app, removed or not: nothing is merged. The
  rows, the settings everyone shares, and the own settings, switches and
  pins of people who are in both spaces go along; those of everyone else are
  deleted first, since the database refuses a row about a person in a
  space they are not in. Access starts afresh: every exception goes, members
  get `memberAccess` (`none` when left out), and a caller who is not an
  owner of the new space gets edit there, as when they add an app. Who
  added the app, and when, stays recorded.
- `PATCH .../apps/:appId/me` (`setAppPrefs`) sets the caller's own switch
  and pin in `app_prefs`, and nobody else's. Anyone who can see the app may,
  view access included; `404` for anyone it is hidden from. What the request
  leaves out stays as it is, and `{}` writes nothing. No row means switched
  on and not pinned. Nobody's access changes.

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
  `db`. It has no space ID. `ctx.settings` holds every setting the manifest
  declares by name: the space's value or this person's own, read inside
  the same transaction (see below).

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

**An app's settings** (`src/apps/settings.ts`) are what its manifest
declares, filled with what people saved. A setting with scope `space` has
one value for the whole space; one with scope `user` has a value for each
person in that space.

- `GET .../apps/:appId/settings` answers `{ space, user }` with every
  declared setting under its scope: the shared values, and the caller's
  own. Anyone who can see the app may read them; `404` otherwise.
- `PATCH` on the same address takes `{ space?, user? }` and saves the
  settings it names, all of them or none, then answers like the `GET`.
  Naming a setting under `space` needs edit access (`403` for a viewer,
  before anything is said about the values). A person's own settings need
  only view, and are saved for that person alone.
- `400` `invalid_request` for a name the manifest does not declare under
  that scope, and for a value that does not fit its setting. The message
  names it: `space.servings: Must be at most 12.` The rules are those of
  `settingValueProblems` in `@hearth/sdk/manifest-schema`, which also
  checks the manifest's own defaults.
- The check of who is asking and the change are one immediate transaction.
- Only values are stored: one JSON object for the space (`user_id` null)
  and one per person, holding what was saved and nothing else. Defaults
  are filled in when settings are read, so a manifest's default can change
  without touching the database.
- Stored values are read against today's manifest. A value under a name
  the manifest no longer declares, or under the other scope, is not read. A
  value that no longer fits its setting reads as the default; a
  multi-select first loses the keys that are no longer options. None of
  this is logged: it is what a release does to settings.
- Saving replaces the named values and leaves everything else in the
  stored object as it is, read or not. A release that is rolled back
  therefore finds the values of a setting the newer one had dropped.
- Removing the app keeps its settings and adding it again brings them
  back; deleting the app's data deletes them. A person's own settings go
  when the person leaves the space.
- There is no way to put a setting back to "not saved". A value equal to
  the default is stored like any other, and stays when the default changes.

## Groups and members

The code is in `src/groups`; the access route and the owners' list are in
`src/apps` with the rest about apps.

**Who may create a group, and who may invite** someone who is not on the
server yet, is `groupRights` in `src/groups/policy.ts`: the server's owner
alone, unless `HEARTH_GROUP_POLICY=everyone` opens both to everyone on the
server. The session says what it answers, and the routes ask it again. A
refusal is `403`.

**Managing a group** (`src/groups/members.ts`) is for its owners, and a
group may have several. Any owner may rename it, add people, change their
role or right to add apps, remove them (other owners too) and take
invitations back. Anyone may leave. Each check and its change are one
immediate transaction.

- `404` for someone who is not in the space, `403` for a plain member,
  `409` for a personal space, which nobody joins, leaves or renames.
- Adding an address: someone on the server becomes a member at once;
  anyone else is invited (a row in `invitations` and one in
  `space_invitations`), if `groupRights` allows, and joins when they first
  arrive. `409` for someone already in the group or already invited, `400`
  for an address Hearth does not accept. Addresses go through
  `normaliseEmail`.
- A group keeps at least one owner: the database refuses to remove or
  demote the last one, and that is answered with `409`.
- Removing someone deletes their exceptions, switches, pins and own
  settings in the group's apps (the database cascades). The rows they
  wrote stay: they belong to the group.
- Taking back an address's last invitation to a group also takes back its
  invitation to the server.

**Who can use an app** is decided by the space's owners
(`PUT .../apps/:appId/access`, `setAppAccess` in `src/apps/installs.ts`):
what every member gets (`member_access`), and exceptions for single members
(`app_access`). `404` when `resolveInstall` gives `null` for the person
asking, `403` for a member, `400` for an exception for someone not in the
space; the request is saved as a whole or not at all. An owner can use
every app whatever their exception says; exceptions stay when a member
becomes an owner and count again if they stop being one. New members get
what every member gets.

**The owners' list** (`GET /api/spaces/:spaceId/apps`, `listSpaceApps`)
reports these decisions with the space's people and invitations. It decides
nothing: `resolveInstall` stays the one answer to what a person may do.

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
column `space_members.can_add_apps`. The server writes `space_apps`; the
access route, and adding or moving an app as a member, write `app_access`;
an app's mutations write `app_rows` through the store, the settings route
writes `app_settings` and the switch-and-pin route `app_prefs`; all of them
are deleted from when an app's data is deleted, and a move deletes from the
last three what is about people who are not in the new space. The routes
for groups write
`spaces`, `space_members`, `invitations` and `space_invitations`. SQL for
`app_rows` and `app_settings` lives in `src/apps/store.ts` only.

Rules the database keeps by itself, tested as SQL in
`src/db/apps-schema.test.ts`:

- Every table with a `space_id` and an `app_id` refers to `space_apps` with
  `ON UPDATE CASCADE`, so an app moves to another space with one `UPDATE`. A
  new table of that kind needs the same key; a test fails without it. One
  that also has a `user_id` must be cleared by `moveApp` of people who are
  not in the new space; another test names the three there are and fails
  for a fourth.
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
pnpm --filter @hearth/server build      # writes dist/main.js; run `pnpm apps:sync` first, as `pnpm build` does
pnpm --filter @hearth/server start      # runs dist/main.js
```

The tests need no network and no settings: they use in-memory databases,
temporary folders, and a key pair generated on the spot for the Cloudflare
Access verifier.
