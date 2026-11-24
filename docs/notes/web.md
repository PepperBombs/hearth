# Notes: the web app

The React app in `packages/web`: the session, lists of apps, dialogs, the settings dialog, the UI kit it is drawn with, the two languages. An app's page in its sandbox (`src/made`) and the chat are in `docs/notes/platform.md`.

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
- The dashboard draws a card for each app the session lists and the person
  switched on, in the size its manifest asked for. The shell draws the
  frame (icon, name, space tag, the settings button, "Open"); inside it is
  the app's own page in its sandbox, small (`<MadeAppFrame>` in
  `src/made/frame.tsx`, `view` "card"), and at `/apps/:spaceId/:appId` the
  same page whole (`view` "page") below the shell's top bar. Every app the
  session lists is drawn that way: no web code reads `app.made`.
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
- The kit's `Dialog` closes itself when it is taken off the page while open (a parent that draws it only while some state is set), so the browser gives focus back to what had it. When that control goes too, as a deleted conversation's delete button does, move focus to something that stays, in an effect once it is gone (`chat.tsx`, `refocus`).
- The dialog that adds an app offers the built-in apps (`GET /api/catalog`,
  `useCatalog` in `src/apps/manage.tsx`) that the space has no copy of: the
  session's `template` of an app says which built-in app it came from. When
  there is none to offer it says why: Hearth ships none, or the space has
  every one, with a link to the chat, where every other app is made; or the
  catalog could not be read, with "Try again". Adding goes through
  `POST /api/spaces/:spaceId/catalog/:templateId` alone.
- For an owner, the dialog that adds an app reads the owners' list
  (`useSpaceApps`, also for a personal space) and adds nothing until it has
  it, so that a built-in app the space removed is shown as coming back with
  its data ("Bring back"). A member who may add apps reads no owners' list.
- The Apps page draws a space's removed apps for its owners ("Removed apps", `RemovedApps` in `pages/apps.tsx`) from the owners' list, which gives their names, icons, colours and entry counts, since the session lists no removed app. "Bring back" is the `PUT` of the app (`bringBackApp`), "Delete permanently" the `DELETE .../data` with the typed name (`deleteAppForGood`); an app in use offers the same dialog from its Remove dialog. The delete dialog deletes nothing until the owners' list has said how many entries go, and compares the typed name, trimmed and case for case, with the name in either language, as the server does.
- The kit's `Button` has a `danger` variant (red, for what cannot be undone: deleting an app for good, the chat's Delete in a request to delete); `packages/web/tests/contrast.test.ts` holds its colours in light and dark.
- The settings dialog takes the app as the session lists it and draws its
  form from `app.settings`, read as the SDK's `Setting`s
  (`declaredSettings` in `src/apps/settings.ts`). It sends only the values
  the person changed, compared with what was saved when it opened: a saved
  value stays saved even when it equals today's default. It checks values
  with `settingValueProblems` first. After a save it tells the app's pages
  on screen to read their settings again (`notifyMadeAppChanged`): a page
  reads them through its bridge, never through the dialog's cache. A new
  setting type needs a control in `settings-dialog.tsx` too.
- A `not_found` from an app's settings reloads the session (`forApp` in
  `src/apps/settings.ts`; a reload already on its way serves it), which then
  no longer lists the app, and the shell stops drawing it.
- A new required field in the session must also go into the sessions written
  by hand in `e2e/fixtures.ts`, `packages/web/src/session/api.test.ts` and
  `packages/web/src/components/switcher/quick-switcher.test.tsx`.
- The kit's components live in the SDK but their styles are built by the web
  app: `@source` in `packages/web/src/styles/index.css` makes Tailwind read
  `packages/sdk/src/web`. A class used in a file Tailwind does not read is
  silently missing from the stylesheet; unit tests do not notice, only the
  end-to-end tests and your eyes do.
- `resolve.dedupe` in `packages/web/vite.config.ts` gives the kit, which
  lives outside this package, this package's React: without it the page
  would hold two.
- Icon and colour names are listed in the SDK (`APP_ICONS`, `APP_COLORS`).
  A new icon also needs its Lucide icon in `packages/sdk/src/web/icon.tsx`
  (a type error until then); a new colour needs a `--hearth-app-*` token in
  light and dark (`packages/web/tests/contrast.test.ts` fails until then).
- The card sizes and the kinds of space are listed in `@hearth/sdk` and
  again in `@hearth/shared`: the SDK imports no other Hearth package, and
  the API contract does not depend on the SDK.
  `packages/web/tests/contract.test.ts` fails when the lists differ.
- The SDK has two type-check projects, because only the kit may use the
  browser: `packages/sdk/tsconfig.json` (everything but `src/web`, no DOM
  types) and `packages/sdk/src/web/tsconfig.json`. Its unit tests likewise
  run as two vitest projects, Node and jsdom.
