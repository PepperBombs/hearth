# @hearth/server

The Hearth server: a small [Hono](https://hono.dev) application on Node that
answers the JSON API under `/api` and serves the built web app for every other
path. It keeps its data in one SQLite file. Each person's own model works in
the chat as their assistant (`src/model`; `docs/platform.md`), as far as a
space's owners allow an assistant there (`src/assistant`).

Every app it holds is made in Hearth (`docs/platform.md`): a manifest and
one HTML page, kept in the database, which the server serves to the
browser's sandbox and never runs. An app is made in the chat or added from
the built-in apps (`catalog/`); it can be removed, brought back, moved with
its data to another space and its data deleted; its page reads and writes
rows that belong to one app in one space, through the page around it (see
"Apps"); and groups can be created, people added to them or invited, and
their owners decide who can use each app (see "Groups and members").

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
# At the repository root: shared, web and server.
pnpm build
HEARTH_CONFIG=/path/to/hearth.json pnpm start
```

`pnpm start` runs `node dist/main.js` in this package. The server listens on
`127.0.0.1` and expects Cloudflare Access (through a tunnel on the same
machine) in front of it. Before it listens it brings the built-in apps up to
date and moves to them the installs of the apps of the same name that
releases before them left (see "Built-in apps"). It stops cleanly on
`SIGINT` and `SIGTERM`: it stops listening, lets the open connections
finish, and closes the database, within 5 seconds whatever holds things up.

On a server, `deploy/hearth-deploy.sh` does this for each release: it builds
the framework, tries the result on a spare port against a copy of the
database and then switches systemd's service to it. The script that does
this is the one of the release's own framework commit: the copy installed
on the server hands each run over to it (`docs/self-hosting.md`, step 5).

## Settings

Settings are environment variables. They may also be put in a JSON file named
by `HEARTH_CONFIG`, using the same names as keys; a variable set in the
environment wins over the file. An empty value counts as not set. If anything
is missing or wrong, the server prints what and exits before listening.

A config file written for an earlier release may still hold
`HEARTH_APPS_DIR`, which named the folders of mini-apps a build took in, or
`HEARTH_JOBS`, which switched their jobs on or off. Both are accepted and
their values ignored: every app is made in Hearth now, and none runs a job.

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
| `HEARTH_SECRET` | none | The secret, of 32 characters or more, that seals each person's model key in the database (`src/model/settings.ts`, docs/platform.md). A new secret makes every saved key unreadable, and people enter theirs again. Without it a server that checks sign-ins keeps no key; a dev server makes one up that lasts until it stops. |
| `HEARTH_MODEL_STANDIN` | none | For tests: the address of a stand-in model, speaking the protocol each person chose, that answers every chat in place of their own (`src/model/chat.ts`). Only with `HEARTH_AUTH=dev`. |
| `HEARTH_FETCH_STANDINS` | none | For end-to-end tests: the path of a JSON file of stand-in answers for every fetch an app makes through the server, so that nothing reaches the network (see "An app's fetch"). The copies of the server that `pnpm e2e` starts are given one. Refused unless `HEARTH_AUTH=dev`; the server says at start-up that it is on. |

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

Keep it out of Git and readable only by the account that runs the server: it
may hold `HEARTH_SECRET`.

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
| `GET /api/session` | yes | The user; their spaces, each with their role, whether they may add apps, its members (ID, name and role, no email address) and `assistant`, what an assistant may do there (`none`, `view` or `edit`); `apps`, every app they can use in every space they are in; `canCreateGroups` and `canInvitePeople`, from `groupRights` (see "Groups and members"); and the version. |
| `PATCH /api/me` | yes | Takes any of `name`, `locale`, `theme`; answers with the updated user. |
| `POST /api/spaces` | yes | Creates a group with the caller as its owner. Takes `{ name }`; answers `201` with the space as the session lists it. |
| `PATCH /api/spaces/:spaceId` | yes | Renames a group: `{ name? }`. Owners only. Answers `204`. |
| `POST /api/spaces/:spaceId/members` | yes | Adds someone by address: `{ email, role?, canAddApps? }`. Answers `{ outcome: "added" }` for someone on the server, `{ outcome: "invited" }` for anyone else. Owners only. |
| `PATCH /api/spaces/:spaceId/members/:userId` | yes | A member's `role` or `canAddApps`. Owners only. Answers `204`. |
| `DELETE /api/spaces/:spaceId/members/:userId` | yes | Removes a member: an owner removing anyone, or anyone leaving. Answers `204`. |
| `DELETE /api/spaces/:spaceId/invitations` | yes | Takes back an invitation: `{ email }`. Owners only. Answers `204`. |
| `GET /api/spaces/:spaceId/apps` | yes | The owners' list: every app the space has (removed ones and those the server holds no app for included) with its row count, what members get, the exceptions and `assistant`, whether an assistant may use it here; everyone in the space with their address and right to add apps; the invitations. Owners only. |
| `PUT /api/spaces/:spaceId/apps/:appId/access` | yes | Who can use the app: `{ memberAccess?, members?, assistant? }`, exceptions by user ID, `null` removing one; `assistant: false` leaves the app out of what an assistant may use in the space. Owners only. Answers `204`. |
| `PUT /api/spaces/:spaceId/assistant` | yes | What an assistant may do in the space: `{ level }`, `none` (off, where every space starts), `view` (read only) or `edit` (read and change). Owners only, a personal space's owner included: `404` outside the space, `403` for a member. Answers `204`. |
| `PUT /api/spaces/:spaceId/apps/:appId` | yes | Brings a removed app back to its space with its data; one that is there stays as it is. Takes `{ memberAccess? }`. Answers `204`. An app is added to a space when it is made, in the chat or from the catalog, below. |
| `DELETE /api/spaces/:spaceId/apps/:appId` | yes | Removes the app from the space and keeps its data. Answers `204`. |
| `POST /api/spaces/:spaceId/apps/:appId/move` | yes | Moves the app with its data to another space: `{ toSpaceId, memberAccess? }`. Owners of the space it is in, into a space they own or may add apps to. Answers `204`. |
| `DELETE /api/spaces/:spaceId/apps/:appId/data` | yes | Deletes for good the data of an app that was removed or that the server holds no app for, and a made app with it. Takes `{ confirm }`, the app's ID. Owners only. Answers `204`. |
| `PATCH /api/spaces/:spaceId/apps/:appId/me` | yes | The caller's own switch and pin for the app: `{ enabled?, pinned? }`. Answers `204`. Needs view access. |
| `GET /api/spaces/:spaceId/apps/:appId/settings` | yes | The app's settings in this space: `{ space, user }`, the values everyone shares and the caller's own, defaults filled in. Needs view access. |
| `PATCH /api/spaces/:spaceId/apps/:appId/settings` | yes | Saves the settings named in `{ space?, user? }`; answers like the `GET`. `space` needs edit access, `user` only view. |
| `GET /api/catalog` | yes | The built-in apps: each one's ID, its name and description in both languages, its icon and colour, and the hosts it fetches from (`network`). |
| `POST /api/spaces/:spaceId/catalog/:templateId` | yes | Adds that built-in app to the space as a made app of its own: `{ memberAccess? }`. Owners, and members allowed to add apps. Answers `201` with `{ appId, restored: false }`. For one the space removed, it brings that one back with its data, owners only, and answers `{ appId, restored: true }`. `409` when the space has it already. |
| `GET /api/spaces/:spaceId/apps/:appId/frame` | yes | The app's page, as its sandboxed iframe loads it: its HTML with the theme's colours and the bridge in front, under the sandbox's own Content-Security-Policy. `theme`, `locale` and `view` (`card` or `page`) in the query. Needs view access. |
| `GET /api/spaces/:spaceId/apps/:appId/rows/:collection` | yes | `{ rows }`: the collection's rows, by `orderBy` (a field, `createdAt`, the default, or `updatedAt`) and `desc`, at most `limit` (200 when left out, never more than 5000). Needs view access. |
| `POST /api/spaces/:spaceId/apps/:appId/rows/:collection` | yes | Adds a row: `{ data }`. Answers `201` with `{ row }`. Needs edit access. |
| `PATCH /api/spaces/:spaceId/apps/:appId/rows/:collection/:rowId` | yes | Changes the fields `{ data }` names. Answers `{ row }`. Needs edit access. |
| `DELETE /api/spaces/:spaceId/apps/:appId/rows/:collection/:rowId` | yes | Deletes a row. Answers `204`. Needs edit access. |
| `POST /api/spaces/:spaceId/apps/:appId/rows/:collection/replace` | yes | `{ where, rows }`: the rows whose fields equal `where` (`{}` for all) give way to `rows`, at most 1000, all or nothing. Answers `{ removed, added }`. Needs edit access. |
| `POST /api/spaces/:spaceId/apps/:appId/fetch` | yes | `{ url, headers? }`: a GET the server makes for the app (see "An app's fetch"). Answers `{ ok, status, url, headers, text }`, or `502` with the reason's code when there is no answer. Needs view access. |
| `POST /api/spaces/:spaceId/apps/:appId/versions/:version/restore` | yes | Takes the app back to that version, as a new version. Answers `{ version, previous, restored }`. Needs edit access and the right to add apps to the space. |
| `GET /api/me/model` | yes | The caller's own model: `{ protocol, baseUrl, model, hasKey }`, or `null`. The key never leaves the server. |
| `PUT /api/me/model` | yes | Saves the caller's model: `{ protocol, baseUrl, model, apiKey? }`; without `apiKey` the saved key is kept. Answers like the `GET`. |
| `DELETE /api/me/model` | yes | Forgets the caller's model and key. Answers `204`. |
| `GET /api/spaces/:spaceId/chats` | yes | `{ chats }`: the caller's own conversations with their model in the space, the one used last first, each `{ id, title, createdAt, updatedAt }`. Nobody else's, in a group too. |
| `GET /api/spaces/:spaceId/chats/:chatId` | yes | `{ chat, entries }`: one conversation of the caller's, whole, its entries in order (`ChatEntry` in `@hearth/shared`). `404` for anyone else's, or one of another space, as for one that is not there. |
| `DELETE /api/spaces/:spaceId/chats/:chatId` | yes | Deletes one conversation of the caller's. Answers `204`. What the model made in it stays. |
| `POST /api/chat` | yes | `{ spaceId, chatId?, message }`: the caller's new message to their own model, in a conversation of theirs in the space, or in a new one without `chatId`. The server keeps the conversation and gives the model what was said before. Answered as a stream of server-sent events (`ChatEvent` in `@hearth/shared`), the first `{ type: "chat", chatId, title }` for a new conversation. Before it: `404` for a space or conversation that is not the caller's, `409` while that conversation is answering already, when it holds 500 entries, or, for a new one, when the caller has 500 conversations in the space. |

Every failure has the shape `{ error: { code, message } }`. The message is
English text for logs and network traces; the web app chooses what to show
from the code. Unknown routes under `/api` answer `404` with `not_found`. An
unexpected failure answers `500` with `internal` and no detail; the detail goes
to the server's log. `forbidden` (403) is for a member who may not do this,
and `conflict` (409) for a request that cannot be carried out as things
stand.

## Apps

The code is in `src/apps` (apps in spaces, the store, settings, an app's
fetch) and `src/made` (apps made in Hearth); the design is
`docs/platform.md`.

**The registry.** Every app the server holds is made in Hearth.
`madeAppsRegistry(db)` (`src/made/apps.ts`) is what every part of the
server asks whether an app exists and what its manifest says: it reads
`made_apps` each time, so a change to an app counts at once. A made app's
manifest (`src/made/manifest.ts`) is checked when it is written: its
collections and fields, and the SDK manifest the server works out from it
(`asSdkManifest`), whose settings and hosts `@hearth/sdk/manifest-schema`
checks (`checkMadeManifest`). Only a built-in app names hosts in `network`.

**Built-in apps.** `catalog/<id>` holds each app Hearth ships, its
`manifest.json` and its `page.html`, written by hand. The server reads and
checks them all when it starts (`loadCatalog`, `src/made/catalog.ts`), and
a broken one stops it before it listens. Then, in `src/made/builtin.ts`:

- `updateBuiltInApps` brings every copy that nobody changed up to the
  built-in app of this release, as a new version, which can be undone like
  any. A copy someone changed is theirs, and stays as it is; so does one
  whose rows would not fit, which the log names.
- `moveLegacyInstalls` moves every install of an app of the same ID
  (`grocery`, `ideas`, `trending`), which the releases before the built-in
  apps built in from a repository of mini-apps, to the built-in app, in
  place: the install gets a made app's ID, which every table about it
  follows, so its rows, settings, access, switches and pins stay, and its
  rows in `app_jobs` are deleted. An install whose rows do not fit stays as
  it was, hidden, since the server holds no app of that ID, and is tried
  again at the next start.

The log has a line for each copy updated and each install moved, and for
each that could not be.

**An app in a space** is a row in `space_apps`.

- A made app is added to its space when it is made, in the chat
  (`create_app`) or from the built-in apps (`POST
  /api/spaces/:spaceId/catalog/:templateId`), through `addApp` either way:
  the person must be an owner of the space or a member allowed to add apps
  (`403` otherwise; `404` if they are not in the space). `memberAccess` is
  what the other members of a group get: `none` (the default), `view` or
  `edit`. A member who adds an app gets edit for themselves. A space has
  one copy of each built-in app: adding one it has is `409`, and adding one
  it removed brings that one back.
- `PUT .../apps/:appId` on an app that is there changes nothing and
  answers `204`; asking for a different `memberAccess` answers `409`. A
  made app lives in one space: for any other the answer is `404`.
- `DELETE .../apps/:appId` removes it: owners only (`403` for a member who
  can use the app, `404` for anyone it is hidden from). Nothing is deleted.
- The same `PUT` on a removed app brings it back with its rows, settings and
  everyone's switches and pins. Owners only, and access starts afresh:
  `memberAccess` as given now, and no exceptions from before. A member who
  may add apps gets `409` for an app the space has an entry for that they
  cannot see.
- `DELETE .../apps/:appId/data` deletes the rows, the settings, the entry
  and the made app itself, for good. Owners only (`403` for any other
  member), `confirm` must be the app's ID (`400`), and the app must have
  been removed or be one the server holds no app for (`409` otherwise).
- `POST .../apps/:appId/move` (`moveApp`) moves the app with its data to
  the space `toSpaceId` names, in one immediate transaction. The caller
  must own the space the app is in (`403` for a member who can use it,
  `404` for anyone it is hidden from, a removed app and one the server
  holds no app for included) and own the other space or be allowed to add
  apps there (`404` when they are not in it or it does not exist, `403`
  for a plain member). `409` when that space has an entry for the app,
  removed or not: nothing is merged. The rows, the settings everyone
  shares, and the own settings, switches and pins of people who are in
  both spaces go along; those of everyone else are deleted first, since
  the database refuses a row about a person in a space they are not in.
  Access starts afresh: every exception goes, members get `memberAccess`
  (`none` when left out), and a caller who is not an owner of the new
  space gets edit there, as when they add an app. Who added the app, and
  when, stays recorded.
- `PATCH .../apps/:appId/me` (`setAppPrefs`) sets the caller's own switch
  and pin in `app_prefs`, and nobody else's. Anyone who can see the app may,
  view access included; `404` for anyone it is hidden from. What the request
  leaves out stays as it is, and `{}` writes nothing. No row means switched
  on and not pinned. Nobody's access changes.

**Who may use an app** is `resolveInstall` in `src/apps/installs.ts`: `null`,
`"view"` or `"edit"`. An owner of the space has edit; a member has their
exception in `app_access`, or else the app's `member_access`; `none`, a
removed app, an app the server holds no app for and a space the person is
not in are all `null`, which every route about one app answers with `404`.
The session lists exactly the apps for which it is not `null`, from the same
SQL. With `by: "assistant"` it answers what the person's own model may do
for them in the chat: the lesser of their access and the space's level,
and nothing in an app its owners left out.

**An app the server holds no app for**, such as an install of an old
mini-app that could not move, or a made app whose manifest this release
cannot read, disappears from every session and answers `404`. Its rows are
not touched. An owner can delete its data without removing it first.

**An app's rows.** A made app's page reads and writes its rows by asking
the page around it, which calls the rows routes with the person's sign-in;
the chat's tools reach them the same way, as an assistant for the person.
`withCollection` in `src/made/apps.ts` does the work:

- Everything happens in one database transaction, the check of who is
  asking first, so a change of access cannot land between the check and
  the work, and what a write does is kept as a whole or not at all.
- `404` when `resolveInstall` gives `null` and for a collection the app does
  not declare; `403` `forbidden` for a write by someone who may only view.
- Every row is checked against the collection's fields as the manifest
  declares them (`collectionSchemas`): a row with another field, or a value
  of another kind, is `400` `invalid_request` with the reason; a row that is
  not there is `404`. A change to the app itself must leave every stored
  row fitting (`rowsNotFitting`), or it is `409`.

**The store** (`src/apps/store.ts`) is what the work gets: the app's
collections, each with `get`, `list` and `count`, and for a write also
`insert`, `update`, `remove` and `removeWhere`. A store made for reading
does not have the writing methods at all.

- A store is made for one request from the space and app of the address and
  the signed-in person. Every statement it runs is limited to that space,
  that app and one collection, so a row of another space is simply not
  found. `created_by` and `updated_by` are the signed-in person.
- Rows are checked against the collection's zod schema when written and
  again when read. A stored row that no longer fits fails the read with a
  `StoredRowError` naming the app, the collection and the row.
- `where` takes fields of the collection and the text, number, switch or
  null each should equal; `orderBy` takes a field, `createdAt` or
  `updatedAt`. Anything else throws `StoreUsageError`. A row stored before
  a field was added counts as holding that field's default, in `where` and
  `orderBy` as in what is read.
- `list` gives at most 1000 rows unless `limit` says otherwise, and never
  more than 5000.
- What the store turns down throws `AppError`: `invalid_request`,
  `not_found` or `conflict`, answered with `400`, `404` or `409` and its
  message. `StoredRowError` and `StoreUsageError` are faults: logged, and
  answered with `500`.
- The store is closed when the work returns and refuses everything from
  then on, so nothing is read or written outside the transaction that
  checked access.

A unit test (`src/apps/store-boundary.test.ts`) fails when a source file
other than `store.ts` and the migrations names `app_rows` or `app_settings`,
or when a statement in `store.ts` does not name its space and app.

**An app's settings** (`src/apps/settings.ts`) are what its manifest
declares, filled with what people saved. A setting with scope `space` has
one value for the whole space; one with scope `user` has a value for each
person in that space. Hearth's settings dialog and an app's own page
(`hearth.settings()`, through the page around it) both use the two routes.

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
  this is logged: it is what a change to an app does to settings.
- Saving replaces the named values and leaves everything else in the
  stored object as it is, read or not. An app taken back to an earlier
  version therefore finds the values of a setting a later one had dropped.
- Removing the app keeps its settings and adding it again brings them
  back; deleting the app's data deletes them. A person's own settings go
  when the person leaves the space.
- There is no way to put a setting back to "not saved". A value equal to
  the default is stored like any other, and stays when the default changes.

**An app's fetch** (`src/apps/fetch.ts`) is how an app's page reaches the
network: `hearth.fetch`, which the page around it sends to `POST
.../fetch`, for anyone who can see the app. The server fetches, from its
own address. Every request meets the same rules, then waits for its host's
turn, then goes out through one transport:

- GET only, to `https` on the default port, without a user name or
  password, to a host the app's manifest lists in `network`, exactly.
  Anything else is refused before it is sent. Only a built-in app lists
  hosts, so an app a person's model made fetches nothing.
- It sends `User-Agent: Hearth` and, of the page's own headers, only
  `accept`, `accept-language`, `if-modified-since`, `if-none-match` and
  names starting with `x-` other than `x-forwarded-*` and `x-real-ip`, with
  plain ASCII values. Nothing of the person's goes out: no cookie, no
  `authorization`, and no cookie is kept.
- Redirects are followed up to 3 times while they stay on https and the
  same host; any other is refused.
- An answer must be whole within 20 seconds, its body included, and its
  body may hold 2 MiB, counted after decompression; past that the
  download stops.
- Requests to one host start at least 6.5 seconds apart across the whole
  server, every app and space together, the next request of a redirect too:
  at most 10 a minute, GitHub's limit for searches without a token. The
  route waits 60 seconds at most, the request's turn included.
- The answer comes whole: its address, status, headers (without
  `set-cookie`) and text. A status that is not 2xx is an answer. When there
  is none, the route answers `502` with the reason (`FetchError`'s code):
  `refused`, `timeout`, `too_large`, `network` or `stopped` (the page went
  away, or the route's time ran out).

On a server the transport is Node's own `fetch`, which follows no redirect
itself. With `HEARTH_FETCH_STANDINS` nothing leaves the server: the file
it names is a JSON list of answers, read again at every request, so that a
test changes them by writing the file (whole: rename a new file into
place).

```json
[
  { "url": "https://api.github.com/search/repositories", "query": { "q": "language:rust" },
    "status": 403, "body": { "message": "API rate limit exceeded" } },
  { "url": "https://api.github.com/search/repositories", "body": { "items": [] } },
  { "url": "https://feeds.example.com/headlines.json", "error": "network" }
]
```

The first entry whose `url` is the request's address without its query,
and each of whose `query` texts is part of that parameter of the request,
answers with its `status` (200 when left out), `headers` and `body` (sent
as is when it is text, as JSON otherwise), or fails at once with its
`error`, `network` or `timeout`. A request no entry answers fails as
`network`, and so does every request while the file is missing or is not
such a list, with a message that says which. Stand-ins answer at once and
are not paced; the rules still come first, so a stand-in opens no host the
manifest does not list.

**Outgoing connections.** The server reaches out to three kinds of host:
Cloudflare Access, for the keys that sign its identity header
(`https://<team domain>/cdn-cgi/access/certs`); the hosts the built-in apps
name in `network`, when a page asks (GET over https, `User-Agent: Hearth`,
at most one request every 6.5 seconds to each host); and each person's own
model, at the address they saved, when they use the chat. With
`HEARTH_FETCH_STANDINS` the second kind is answered from a file instead,
and with `HEARTH_MODEL_STANDIN` the third goes to a stand-in.
`docs/self-hosting.md` lists the connections of a whole server, the
deploy's included.

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
`space_apps` (an app added to a space), `app_rows` (every app's data),
`app_settings`, `app_access`, `app_prefs` and `space_invitations`, plus the
column `space_members.can_add_apps`. Migration 3 adds `app_jobs`: for each
job of an app in a space, when it runs next, the run that holds it and how
its last runs went. Migration 4 adds two columns for the assistant:
`spaces.assistant` (`none`, `view` or `edit`; every space starts at `none`)
and `space_apps.assistant` (1, or 0 for an app its owners left out), which
only the level's route and the access route write. Migration 5 adds
`made_apps` (an app made in Hearth: its manifest, its page and the version
in use) and `user_models` (each person's own model, the key sealed);
migration 6 `made_app_versions` (every version of a made app, the newest
30 kept); migration 7 the columns `made_apps.template` and
`template_hash` (the built-in app a copy was added from, and which release
of it the copy is while nobody changed it). Migration 8 adds `chats` and
`chat_entries`: each person's conversations with their model in a space,
theirs alone, which go when they leave it.

The server writes `space_apps`; the access route, and adding or moving an
app as a member, write `app_access`; the rows routes and the chat write
`app_rows` through the store, the settings route writes `app_settings` and
the switch-and-pin route `app_prefs`; all of them are deleted from when an
app's data is deleted, and a move deletes from the last three what is about
people who are not in the new space. The routes for groups write `spaces`,
`space_members`, `invitations` and `space_invitations`. SQL for `app_rows`
and `app_settings` lives in `src/apps/store.ts` only; for `made_apps` and
`made_app_versions` it is in `src/made/apps.ts` and `src/made/builtin.ts`,
for `user_models` in `src/model/settings.ts`, and for `chats` and `chat_entries` in `src/model/chats.ts`. Nothing writes `app_jobs` any more, since the jobs
of mini-apps were removed: the move of their installs to the built-in apps
deletes the rows of each install it moves (`src/made/builtin.ts`), and the
table stays, as every table that has shipped does.

Rules the database keeps by itself, tested as SQL in
`src/db/apps-schema.test.ts`:

- Every table with a `space_id` and an `app_id` refers to `space_apps` with
  `ON UPDATE CASCADE`, so an app moves to another space with one `UPDATE`. A
  new table of that kind needs the same key; a test fails without it. One
  that also has a `user_id` must be cleared by `moveApp` of people who are
  not in the new space; another test names the three there are and fails
  for a fourth.
- `app_rows` and `app_settings` use `ON DELETE RESTRICT`: delete them first,
  on purpose, then the `space_apps` row. `app_jobs` uses `ON DELETE
  CASCADE`: a job's status is not data, and goes with the app's entry. So
  does `made_apps`, and with it `made_app_versions`: a made app exists
  nowhere but in its space.
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
