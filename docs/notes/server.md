# Notes: the server

The Hono server in `packages/server` and the contract in `packages/shared`: who may use what (`VISIBLE`), installs, calls, the store, settings, groups, refusals, the database's own rules.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- The server's Content-Security-Policy allows scripts from its own origin
  only: no inline scripts, no outside hosts, no outside fonts.
- With `HEARTH_AUTH=dev` the server answers only requests addressed to this
  machine (`localhost`, `127.0.0.1`, `::1`) and refuses any that a proxy or
  tunnel passed on. Reach it by one of those names, also in tests.
- Every email address goes through `normaliseEmail` in
  `packages/server/src/email.ts` before it is compared or stored.
- A JSON config file may still name `HEARTH_APPS_DIR`; the server ignores
  it (`IGNORED_NAMES` in `packages/server/src/config.ts`), so that a file
  written for an earlier release does not fail the deploy's trial start.
- Who may use an app is decided in one place, the SQL named `VISIBLE` in
  `packages/server/src/apps/installs.ts`, which `resolveInstall` and the
  session both read. A route about one app answers 404 when `resolveInstall`
  gives `null`, whatever the reason, so that the reasons cannot be told apart.
  Do not add a second query that works out access. The owners' list
  (`listSpaceApps`, `GET /api/spaces/:spaceId/apps`) reports what was
  decided (`member_access`, `app_access`) and decides nothing; only the web
  app's table reads an effective level off it, for display, and a test
  (`src/apps/access.test.ts`) checks that reading against the sessions.
  What an assistant may do for a person (section F) is worked out there
  too, as `VISIBLE`'s `assistant`: the lesser of the person's access and the
  space's level (`spaces.assistant`: `none`, the default, `view` or
  `edit`), and `none` for an app its owners left out
  (`space_apps.assistant` = 0). `resolveInstall` with `by: "assistant"`
  (a `Caller`, which `callApp`'s call carries) and `listAssistantInstalls`
  read it; the session's spaces carry the level, the owners' list each
  app's `assistant`, and only owners change either (`PUT
  /api/spaces/:spaceId/assistant`, in `src/assistant`, and `assistant` in
  the access route).
- Who may create a group and who may invite someone who is not on the
  server yet is `groupRights` in `packages/server/src/groups/policy.ts`, read
  from `HEARTH_GROUP_POLICY` (`owner`, the default, or `everyone`; owner's
  decision 4). The session's `canCreateGroups` and `canInvitePeople` come
  from it and the routes ask it again; the web app reads the session and
  never decides this itself.
- An invitation to a group is two rows: `invitations` (lets the person onto
  the server) and `space_invitations` (what they become in the group).
  `resolveMember` turns the second into membership in the transaction that
  creates the user (`joinInvitedSpaces` in `src/db/people.ts`). Taking back
  an address's last group invitation deletes its `invitations` row too, since
  a group is the only way in the interface offers; a new way to invite
  someone to the server alone must revisit that.
- A change to `space_members` that could take away the last owner goes
  through `keepingAnOwner` (`src/groups/members.ts`), which turns the
  triggers' `SQLITE_CONSTRAINT_TRIGGER` into 409 `conflict`. Every owner of a
  group manages it (owner's decision 3); anyone may leave; a personal space
  answers 409 to every route about members.
- Exceptions in `app_access` stay when a member becomes an owner, count for
  nothing while they are one, and apply again if they are made a member
  again, so stepping someone down never widens what they had. The access
  route accepts an exception for anyone in the space, owners included.
- To turn a request down, throw `Refusal` (`packages/server/src/http/errors.ts`)
  from anywhere, also inside a transaction: the error handler answers with
  its status and code, and it is not logged. Its message reaches the client,
  so it must not say what the person may not know. Read a request body with
  `readBody` and its schema from `packages/shared`.
- A check and the change it allows go in one `db.transaction(...).immediate()`,
  as in `installs.ts`, so that a revoke cannot land between them.
- SQL that names `app_rows` or `app_settings` belongs in
  `packages/server/src/apps/store.ts` and in test files, nowhere else, and
  every statement there names its space and app. A test fails otherwise
  (`store-boundary.test.ts`); it reads source text, so a comment that names
  the tables in another file fails it too.
- A mini-app's handler never gets a database handle, a space ID or a user ID
  to pass on. `ctx.db` is built in `calls.ts` from the space and app of the
  address and the signed-in person, after `resolveInstall`, inside the same
  transaction (deferred for a query, immediate for a mutation). Keep it so
  when adding to `ctx` or to the store.
- Handlers are synchronous. One that returns a promise is answered with 500,
  and the store is closed when the handler returns, so that an `async`
  handler cannot write after the transaction. Do not add an `await` between
  the access check and the handler.
- What a handler does wrong has three kinds. `AppError` (from the SDK) is the
  request turned down: 400, 404 or 409, not logged. `StoreUsageError` is the
  app misusing the store, and `StoredRowError` a stored row that no longer
  fits its collection: both are logged inside an `AppFaultError` and answered
  with 500, like any other error a handler throws.
- Every query, mutation and job needs a `description`, one English
  sentence (owner's decision 7). The types require it and `checkServer`
  (`packages/server/src/apps/definition.ts`) refuses a server file without
  one at start-up, fixtures and test apps included. A job also needs
  `everyMinutes`, a whole number from 15 to 10080 (`JOB_INTERVAL` there),
  and takes no input; an input given to `app.job` past the types is kept
  on the job so that the check can refuse it. An app whose manifest names
  hosts in `network` must define a job, since only a job fetches:
  `createRegistry` refuses it otherwise, an app without a server file
  included.
- `main.ts` only hands the build's list of apps to `serveHearth`
  (`src/serve.ts`), which is the whole process: the settings and the apps
  checked before the database opens (status 1 for either), the
  migrations, `startServer` (the scheduler, its way out, the application
  and the listening socket), the signals, and a rejected promise that
  nothing handled, which it logs on one line (`unhandledRejectionLine`)
  instead of letting Node end the process: a job's function may leave
  one behind, and it is not waited for once its run is over. A test runs
  `startServer` with a clock that moves when told and a global `fetch`
  that refuses every host but this machine; a last one starts a whole
  process with `serveHearth` and a made-up app (`src/test-process.ts`,
  through `tsx`) and checks that a rejection its job leaves behind is
  logged and the process serves on, then ends with status 0 on SIGTERM.
- Settings are stored as values only, one JSON object for the space and
  one per person, and read against today's manifest in one place, `fill` in
  `packages/server/src/apps/settings.ts`, which the two routes, a
  handler's `ctx.settings` (`settingsFor`) and a job's
  (`spaceSettingsFor`) share. A name the manifest does not
  declare under that scope is not read; a value that no longer fits reads
  as the default. Saving replaces the named values and must leave the rest
  of the stored object alone, so that a rolled-back release finds its
  values again. Never copy defaults into the database.
- Whether a value fits a setting is decided by `settingValueProblems` in
  `packages/sdk/src/manifest-schema.ts`, for a manifest's defaults and for
  what people save alike. A new setting type or limit goes there, into the
  types in `packages/sdk/src/index.ts` and into the schema beside it. A
  number's `step` limits values: `min` (or 0) plus a whole number of steps.
- Saving a setting of the space needs edit access; a person's own needs
  only view (owner's decision 5). The settings `PATCH` checks access, then
  names and values, then writes, in one immediate transaction, and saves a
  request as a whole or not at all.
- The store matches and sorts with SQL on the stored JSON but returns rows
  parsed by the collection's schema. The two agree because a row is stored
  as the schema's own output and a missing field counts as its default; a
  schema whose output it would not accept again is refused on insert.
- Removing an app from a space only sets `space_apps.removed_at`. Its rows,
  settings, switches and pins stay; bringing it back resets access
  (`member_access` as asked, exceptions deleted, and the app included for
  the assistant again) and nothing else.
- `createApp` throws `AppRegistryError` for a bad manifest, an entry whose
  `id` differs from its manifest's, an ID that comes twice, or an entry
  that names `server` with nothing in it (a `server.ts` without a default
  export; the generated list names `server` exactly when the file exists).
  `serveHearth` (`src/serve.ts`, which `main.ts` runs) makes the same
  check before it opens the database and exits with status 1, which is
  what fails the deploy's trial start.
- A space may have several owners and must keep one. Triggers on
  `space_members` enforce it: insert the owner of a new space before anyone
  else, and expect `SQLITE_CONSTRAINT_TRIGGER` when the last owner is removed
  or demoted.
- Every table with `space_id` and `app_id` columns needs the composite
  foreign key to `space_apps` with `ON UPDATE CASCADE` (a test in
  `packages/server/src/db/apps-schema.test.ts` fails without it): moving an
  app is one `UPDATE` of `space_apps.space_id`. `app_rows` and `app_settings`
  are `ON DELETE RESTRICT` on purpose; `app_jobs` is `ON DELETE CASCADE`,
  since a job's status is not data and goes with the app's entry.
- Moving an app (`moveApp` in `packages/server/src/apps/installs.ts`, one
  immediate transaction) cannot carry a row about a person into a space that
  person is not in: the database refuses it. So it first deletes every
  `app_access` row, and the `app_prefs` and own `app_settings` of people who
  are not in the target (`deleteOwnSettingsOfOthers` in `store.ts`). A new
  table with `space_id`, `app_id` and `user_id` must be cleared there too;
  a test in `apps-schema.test.ts` names the three and fails until it is.
  Access starts afresh where the app goes: no exceptions, members get the
  `memberAccess` asked for ("none" when left out), a mover who is not
  an owner there gets an `edit` exception, as when adding, and the app is
  included for the assistant under that space's level. A target with an
  entry for the app, removed or not, is 409: nothing is ever merged.
- Request schemas in `packages/shared` refuse unknown properties
  (`z.strictObject`); answers such as the session do not, so that a browser
  holding an older web app survives a newer server.
