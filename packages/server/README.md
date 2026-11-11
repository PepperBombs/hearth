# @hearth/server

The Hearth server: a small [Hono](https://hono.dev) application on Node that
answers the JSON API under `/api` and serves the built web app for every other
path. It keeps its data in one SQLite file.

At this step it is the app shell only. There are no mini-apps yet, so the
session always lists `apps: []`.

## Run it in development

From the repository root:

```sh
HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com pnpm --filter @hearth/server dev
```

This starts the server on `http://127.0.0.1:4310` and restarts it when a file
changes. `HEARTH_AUTH=dev` switches sign-in off: every request is treated as
`HEARTH_DEV_USER` (by default the owner). The database is created at
`packages/server/data/hearth.db`, which Git ignores.

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
| `HOST` | `127.0.0.1` | Address to listen on. Leave it on loopback unless something on another machine must connect. |
| `PORT` | `4310` | Port to listen on. |
| `HEARTH_DB` | `./data/hearth.db` | Path of the SQLite file. Its folder is created if needed. |
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
| `GET /api/session` | yes | The user, their spaces with their role in each, `apps: []`, and the version. |
| `PATCH /api/me` | yes | Takes any of `name`, `locale`, `theme`; answers with the updated user. |

Every failure has the shape `{ error: { code, message } }`. The message is
English text for logs and network traces; the web app chooses what to show
from the code. Unknown routes under `/api` answer `404` with `not_found`. An
unexpected failure answers `500` with `internal` and no detail; the detail goes
to the server's log.

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
- Answers under `/api` are sent with `Cache-Control: no-store`.
- Request bodies over 64 KB are refused.

## Database

SQLite through `better-sqlite3`, in WAL mode with foreign keys on. The schema
is a list of numbered migrations in `src/db/migrations.ts`; the ones that have
run are recorded in the `migrations` table and the rest are applied at
start-up, each in its own transaction. Add a new migration with the next
number; never change one that has shipped. The server refuses to start on a
database that a newer build has migrated.

Tables so far: `users`, `spaces`, `space_members`, `invitations`. Back the
database up with SQLite's own backup command, not by copying the file while
the server runs.

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
