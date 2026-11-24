# Notes: the server

The Hono server in `packages/server` and the contract in `packages/shared`: who may use what (`VISIBLE`), installs, the store, settings, groups, refusals, the process, the database's own rules. What is only about apps made in Hearth (their manifests, the sandbox, `hearth.fetch`, the built-in apps, the chat) is in `docs/notes/platform.md`.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- The server's Content-Security-Policy allows scripts from its own origin
  only: no inline scripts, no outside hosts, no outside fonts.
- With `HEARTH_AUTH=dev` the server answers only requests addressed to this
  machine (`localhost`, `127.0.0.1`, `::1`) and refuses any that a proxy or
  tunnel passed on. Reach it by one of those names, also in tests.
- Every email address goes through `normaliseEmail` in
  `packages/server/src/email.ts` before it is compared or stored.
- A JSON config file may still name `HEARTH_APPS_DIR` or `HEARTH_JOBS`,
  settings of the mini-apps framework that was removed; the server ignores
  both (`IGNORED_NAMES` in `packages/server/src/config.ts`), so that a file
  written for an earlier release still starts the server. A name it does
  not know otherwise stops it.
- Who may use an app is decided in one place, the SQL named `VISIBLE` in
  `packages/server/src/apps/installs.ts`, which `resolveInstall` and the
  session both read. A route about one app answers 404 when `resolveInstall`
  gives `null`, whatever the reason, so that the reasons cannot be told apart.
  Do not add a second query that works out access. The owners' list
  (`listSpaceApps`, `GET /api/spaces/:spaceId/apps`) reports what was
  decided (`member_access`, `app_access`) and decides nothing; only the web
  app's table reads an effective level off it, for display, and a test
  (`src/apps/access.test.ts`) checks that reading against the sessions.
  What an assistant (each person's own model, in the chat) may do for a
  person (section F's switches) is worked out there too, as `VISIBLE`'s
  `assistant`: the lesser of the person's access and the space's level
  (`spaces.assistant`: `none`, the default, `view` or `edit`), and `none`
  for an app its owners left out (`space_apps.assistant` = 0).
  `resolveInstall` with `by: "assistant"` (a `Caller`, which the chat's
  `MadeRequest` carries) reads it; the session's spaces carry the level,
  the owners' list each app's `assistant`, and only owners change either
  (`PUT /api/spaces/:spaceId/assistant`, in `src/assistant`, and
  `assistant` in the access route).
- Every app the server holds is made in Hearth: the registry is
  `madeAppsRegistry(db)` (`src/made/apps.ts`), which reads `made_apps`
  each time it is asked, so a change to an app counts at once. An ID that
  is no made app's, or whose manifest no longer reads, is no app: its
  install is hidden from everyone and its data left alone, and an owner can
  delete that data without removing it first. An install the move of the
  old apps could not move (`docs/notes/platform.md`) is such an install
  until a later start moves it.
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
- The only member leaving a group deletes it (`deleteGroup` in
  `src/groups/members.ts`), once `confirm` is its name, trimmed and case for
  case, else 409 `confirm_required`. In the same transaction it deletes each
  app's rows and settings through `store.ts`, the `space_apps` entries (no
  cascade from `spaces`), the pending invitations as `withdrawInvitation`
  does, then the `spaces` row, whose cascades take the members and their
  conversations. A new table with `space_id` must be emptied there: the test
  in `routes.test.ts` finds every such table from the schema. A name sent by
  someone leaving a group others are in is 409 `conflict`, never a plain
  leave: an invitee who arrived as an owner would otherwise be handed the
  group the person meant to delete.
- The session gives `pendingInvitations` for a group to its owners alone
  (`listSpacesForUser` in `src/db/people.ts`).
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
- Nothing a request says names the space, the app or the person of a store.
  `withCollection` (`src/made/apps.ts`) makes the store from the route's
  address and the sign-in, after `resolveInstall`, inside the same
  transaction, and closes it when the work returns; a closed store refuses
  everything. Keep it so when adding to the store or to what a page may
  ask for.
- What the store does wrong has three kinds. `AppError` (`store.ts`) is a
  request turned down: 400 for a row that does not fit, 404 for one that is
  not there, 409, which `withCollection` turns into a `Refusal` of that
  status, not logged. `StoreUsageError` is the store asked for something it
  does not do, and `StoredRowError` a stored row that no longer fits its
  collection: both are faults, logged and answered with 500. So a page's
  `replace` whose `where` names a field the collection lacks answers 500
  and is logged, not 400: not fixed yet.
- `main.ts` only runs `serveHearth` (`src/serve.ts`), which is the whole
  process: the settings checked before the database opens (status 1), the
  migrations, `startServer` (the apps' way out, the built-in apps brought
  up to date and the old apps' installs moved to them, the application and
  the listening socket), the signals, and a rejected promise that nothing
  handled, which it logs on one line (`unhandledRejectionLine`) instead of
  letting Node end the process. On SIGTERM or SIGINT the server stops
  listening, lets its connections finish and closes the database, within 5
  seconds whatever holds things up (`STOP_LIMIT_MS`, on the clock it was
  given). `src/serve.test.ts` runs `startServer` with a clock that moves
  only when told (`fakeClock`, `src/apps/test-clock.ts`), and starts
  `main.ts` as a whole process through `tsx`: it serves, logs a rejection
  that a preloaded module leaves on SIGUSR2 and goes on serving, and ends
  with status 0 on SIGTERM, and with status 1 before it opens the database
  when its settings are not valid. `hearth.fetch` leaves no rejection of its
  own unhandled when nothing waits for its answer (`fetchFor`, tested in
  `fetch.test.ts`).
- Settings are stored as values only, one JSON object for the space and
  one per person, and read against today's manifest in one place, `fill` in
  `packages/server/src/apps/settings.ts`, which the two routes share. A
  name the manifest does not declare under that scope is not read; a value
  that no longer fits reads as the default. Saving replaces the named
  values and must leave the rest of the stored object alone, so that an app
  taken back to an earlier version, or a release rolled back, finds its
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
- `PUT /api/spaces/:spaceId/apps/:appId` only brings back a removed app:
  a made app is added to its space when it is made (`createMadeApp`, from
  the chat or from the catalog's route) and to no other, so for any other
  space the answer is 404. The owners' list (`GET .../apps`) gives each app
  the server holds its name in both languages, icon and colour, removed or
  not, since the session no longer lists a removed one and the Apps page
  draws it from there.
- `DELETE /api/spaces/:spaceId/apps/:appId/data` deletes an app for good,
  in use or removed, owners only, and wants `confirm` to be its name in
  either language, trimmed (its ID for an install the server holds no app
  for), else 400. In one immediate transaction (`deleteAppData` in
  `installs.ts`) it expires the app's waiting requests to delete
  (`expireRequestsFor`), deletes its rows and settings through `store.ts`,
  then its `space_apps` entry, whose cascades take access, prefs, switches,
  `made_apps` and its versions.
- A space may have several owners and must keep one. Triggers on
  `space_members` enforce it: insert the owner of a new space before anyone
  else, and expect `SQLITE_CONSTRAINT_TRIGGER` when the last owner is removed
  or demoted.
- `chats` (migration 8, each person's conversations with their model)
  refers to `space_members` by space and person with `ON DELETE CASCADE`,
  and `chat_entries` to `chats` by conversation, space and person the same
  way: a person's conversations in a space go when they leave it or are
  removed, and nothing else deletes them but the person
  (`src/db/chats-schema.test.ts`). Their SQL is in `src/model/chats.ts`
  alone.
- `chat_confirmations` (migration 9, the model's requests to delete rows,
  waiting for the person) refers to its conversation, `chats`, by
  conversation, space and person with `ON DELETE CASCADE`, and on purpose
  not to `space_apps`: a request outlives its app (it expires) and stays in
  the space it was asked in when the app moves (moving expires it too).
  Its SQL is in `src/model/confirmations.ts` alone, every statement scoped
  by space and person but `expireRequestsFor`, which ends everyone's
  requests about an app that is deleted or moved. Its status is read
  afresh into the conversation whenever it is read; a request past 24
  hours shows as expired at once but is written so only when someone acts
  on it.
- Every table with `space_id` and `app_id` columns but `chat_confirmations`
  needs the composite foreign key to `space_apps` with `ON UPDATE CASCADE`
  (a test in `packages/server/src/db/apps-schema.test.ts` fails without it,
  and names that one exception): moving an app is one `UPDATE` of
  `space_apps.space_id`. `app_rows` and `app_settings`
  are `ON DELETE RESTRICT` on purpose; `app_jobs` is `ON DELETE CASCADE`,
  since a job's status is not data and goes with the app's entry, and so is
  `made_apps`, since deleting the install deletes the app.
- `app_jobs` (migration 3) is kept although nothing writes it any more: the
  jobs of the mini-apps framework did, and the move of the old apps deletes
  the rows of each install it moves (`forgetJobs` in `src/made/builtin.ts`).
  Migration 3's comment still names `src/apps/jobs.ts`, which is gone: a
  migration that has shipped is never changed, its comments included.
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
- The app center's table, `published_apps` (migration 10, docs/center.md),
  is named in `src/center/published.ts` alone, every statement there names
  a group (its own `space_id`, or `LISTED`, the person's groups), and a
  test reads the source for both (`src/center/published.test.ts`). It goes
  with its publisher's membership of the group, by cascade, and sets
  `made_apps.origin` of its copies to NULL.
- Publishing (`src/center/publish.ts`) is for an owner of the app's space
  (`publishableApp` in `src/made/apps.ts`); its email check looks only for
  the addresses of the publisher and of people they share a space with
  (`emailsAround` in `src/db/people.ts`), never every address on the server.
- Server tests that need a group mostly insert it with SQL (`family()` in
  `src/apps/test-world.ts`), and their apps with `makeApp` there, a made
  app written straight into the database; `src/groups/routes.test.ts`
  makes groups through the routes, and `src/made/made.test.ts` apps
  through `createMadeApp`.
- Request schemas in `packages/shared` refuse unknown properties
  (`z.strictObject`); answers such as the session do not, so that a browser
  holding an older web app survives a newer server.
- A copy of a published app (docs/center.md) is an ordinary made app whose
  `made_apps.origin_hash` is set; the rest of the server learns of it from
  the registry (`RegisteredApp.copy`), never from `made_apps` itself, and
  `moveApp` refuses to move an untouched one into a group.
