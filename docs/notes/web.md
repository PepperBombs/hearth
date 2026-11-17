# Notes: the web app

The React app in `packages/web`: the session, lists of apps, dialogs, an app's queries and jobs in the browser, the two languages.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- Every interface string goes in both `packages/web/src/i18n/en.ts` and
  `zh.ts`; a missing key is a type error. Every Chinese string must hold
  Chinese text (an i18n test), so what is punctuation alone stays in code:
  `joinNames` (`packages/web/src/i18n/index.ts`) joins names that are the
  same in both languages, such as host names, with ", " or "、". Words in
  [brackets] name a page and are drawn as a link to it by `LinkedText`
  (`packages/web/src/components/linked-text.tsx`), wherever they fall in
  each language; an i18n test checks that both languages mark the same
  link. A string with brackets must be drawn with `LinkedText`.
- The dashboard draws a card for each app the session lists, and the card's
  inside from the build's list: an app the session lists and this build
  lacks gets "Reload to update". The shell draws the frame (icon, name,
  space tag, the settings button, "Open"), the skeleton and the failed state; an app's widget
  and page have no loading or error code of their own. Server tests that
  need a group mostly insert it with SQL (`family()` in
  `src/apps/test-world.ts`); `src/groups/routes.test.ts` makes them
  through the routes.
- Every list of apps on screen comes from `enabledApps` (switched on,
  pinned first) or, on the Apps page alone, from all of `session.apps`, in
  `packages/web/src/session/session.ts`. A switch or pin is
  `PATCH .../apps/:appId/me`, the caller's own row in `app_prefs`; the page
  shows it before the server answers and then loads the session again.
- Adding, removing and moving an app, and every change to a group, load
  the session (and the owners' list) again whatever the server answered: a
  refusal usually means the page was out of date. That reload can take a
  dialog away before its mutation settles, and TanStack Query then skips
  the callbacks given to that one `mutate` call. A dialog whose open state
  is kept by something the reload leaves on the page must not count on
  them to close it: close it with `mutateAsync(...).then(...)`, and clear
  that state while rendering once the page no longer shows what the dialog
  is about, as `People` and `AddApp` do; otherwise it opens by itself when
  that comes back.
- The access table and the Assistant card's boxes show a choice before the
  server answers, and when it fails put back at once what that choice set
  and nothing else (`undoing` in `groups/access-table.tsx`): a dropped
  connection fails the reading again too, and putting back the whole list
  as it was would undo, or bring back, another choice on its way. Whether
  a choice failed is kept in state: the mutation knows only of the latest.
- A failure is said in a `role="alert"` that comes onto the page with its
  text, as in the groups' cards, the access table, the Apps page and their
  dialogs, or in a polite region that was on the page before it (the
  Assistant card's `Problem`, `ChangeFailed` in `app-view.tsx`, the
  settings dialog's footer). Never in a `role="status"` that arrives
  holding its text: screen readers often say nothing of it. A failure that
  takes another message's place is an element of its own, not the other
  with its role changed. Tests find it by its role (`alertText`).
- For an owner, the dialog that adds an app reads the owners' list
  (`useSpaceApps`, also for a personal space) and adds nothing until it has
  it, so that an app the space removed is shown as coming back with its
  data ("Bring back"). A member who may add apps reads no owners' list.
- The settings dialog sends only the values the person changed, compared
  with what was saved when it opened: a saved value stays saved even when it
  equals today's default. It checks values with `settingValueProblems`
  first, and shares its cached settings with `<AppScope>` (`settingsQuery`).
  A new setting type needs a control in `settings-dialog.tsx` too.
- An app's `useQuery` suspends and is read again after any mutation of the
  same app in the same space that the server answered, saved or turned
  down, on window focus and every 15 seconds while the window is visible
  (`REFRESH_EVERY_MS` in `packages/web/src/apps/scope.tsx`); settings
  likewise. Any `not_found`
  from an app's routes reloads the session (one reload on its way serves
  them all); after a mutation's `not_found` the app is read again only if
  the reloaded session still lists it. Everything cached for one
  install starts with `installQueryKey`, so invalidating that key refreshes
  the whole app. It suspends again for an input it has not answered yet,
  and `<AppView>`'s skeleton then takes the place of the whole widget or
  page, unless the update is a transition: an app whose query follows a
  control passes the input through React's `useDeferredValue`, as GitHub
  Trending's page does (the SDK's README says so to app authors).
- A job's status (`useJob`) is read with the queries, and every 3 seconds
  (`RUNNING_REFRESH_MS`) while a run is going on or was asked for, which
  includes one waiting out its 5 minutes; a hidden window reads none of
  it. When a status that has just come names a later run that went well
  than the cached one, `<AppScope>` (`received` in `scope.tsx`) drops the
  answers it keeps of the app's queries that are not on the screen, reads
  those on the screen again and waits for them, then drops any that left
  the screen meanwhile (their reading was called off), and only then
  shows that status: so the data is never older than "Updated ..." says,
  and a list shown again later, another range of a page or the page after
  the dashboard, is read afresh first. `run()` shows the `POST`'s answer,
  after calling off a reading on its way that would put the job back as
  it was; a refused `run()` goes through the mutations' own
  `afterFailedChange`. What a status means (`failedAt`
  only when the last run to end failed, `running` for `running` and
  `requested`) is `jobStateOf` in `@hearth/shared`; read it there, never
  again by hand.
- A new required field in the session must also go into the sessions written
  by hand in `e2e/fixtures.ts`, `packages/web/src/session/api.test.ts` and
  `packages/web/src/components/switcher/quick-switcher.test.tsx`.
- The kit's components live in the SDK but their styles are built by the web
  app: `@source` in `packages/web/src/styles/index.css` makes Tailwind read
  `packages/sdk/src/web`. A class used in a file Tailwind does not read is
  silently missing from the stylesheet; unit tests do not notice, only the
  end-to-end tests and your eyes do.
