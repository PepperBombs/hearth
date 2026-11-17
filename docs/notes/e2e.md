# Notes: the end-to-end tests

The Playwright tests in `e2e`: the stand-in for the server, the copies of the real server they share, and the tests of mini-apps from another repository.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- Removing an app keeps everyone's switches, pins and settings, and the
  end-to-end tests against the real server share one server. A test there
  that changes them puts them back before it removes the app, as
  `e2e/real-server.spec.ts` does. Removing also keeps the app's data, and a
  space that kept an app's data cannot take that app by a move: the move
  test there deletes what earlier tests left in the owner's personal space
  (`DELETE .../data`) before it moves the checklist in. The stand-in in
  `e2e/fixtures.ts` answers add, remove, move, switch and pin and the
  settings `PATCH` for the three sample apps and records them in
  `appChanges`; it also keeps groups (the owners'
  list of each in `groups`, the people it knows in `people`, `ownAFamily`
  for a ready family) and records their changes in `groupChanges`. The
  owners' list of a space it was given none for, a personal one included,
  is drawn from the session. For the headlines it answers their query
  from `headlines` and their job's two routes from `jobs` (by
  "app/job"): a run asked for turns an idle job into `requested` (403 with
  view, 202 otherwise), and a test plays the run by setting the status it
  ended with (`jobThatRan`) and moving the page's clock 3 seconds.
- A phone test checks that nothing reaches past the screen's edge with
  `expectNothingPastTheEdge` (`e2e/fixtures.ts`), never with the document's
  width: the shell clips and the content area scrolls by itself, so the
  document never grows. A part meant to scroll sideways by itself, such as
  the access table's scroller, goes in `SIDEWAYS_SCROLLERS` beside it: what
  is inside it is left to it, and it must fit itself.
- The end-to-end tests start three copies of the real server: the owner's,
  a family member's (Lin, `MEMBER_URL` in `e2e/servers.ts`) and a
  stranger's. The owner's and Lin's share one database file in the system's
  temporary folder (`SHARED_DB`), deleted whenever the owner's copy starts,
  so that a test can be two people on one server. Nothing deletes a space,
  so a group a test creates stays for the tests after it: give it a name of
  its own and do not count groups. The owner's and Lin's copies run their
  jobs, over one file of stand-in answers beside the database (`STAND_INS`,
  so it goes when the owner's copy starts): a test writes it whole with
  `writeStandIns` before it adds an app with a job, since the first run
  follows the adding at once, and until then every request a job makes
  fails. A run asked for there starts 5 seconds after the last one
  started, so a test that refreshes waits that long; the copy that ran a
  failed run logs a line, which shows in Playwright's output. The
  stranger's copy runs no job (`HEARTH_JOBS=off` in `realServerCommand`).
- `e2e/mini-apps` is for the tests of apps of another repository, built in
  by `pnpm e2e:mini-apps` (`playwright.mini-apps.config.ts`): Hearth built
  with those apps, the owner's and Lin's copies of the server on ports 4183
  and 4184 over a database of their own (`MINI_APPS_*` in `e2e/servers.ts`),
  their jobs over one file of stand-in answers (`MINI_APPS_STAND_INS`). A
  file runs only when the folders hold the app it is named after, and the
  command passes with none. It is empty now: the grocery list, GitHub
  Trending and Ideas of `hearth-stones` moved into Hearth as built-in apps
  (`docs/platform.md`), and their tests went with them; the built-in apps
  are tried in `real-server.spec.ts`. Do not run the two Playwright
  commands at the same time: both build into the same `dist` folders.
- Playwright's `serviceWorkers: "block"` (the default in `playwright.config.ts`) runs a script in every frame that reads `navigator.serviceWorker`, which a made app's sandboxed frame refuses with a page error. A test that draws a made app allows service workers (`test.use({ serviceWorkers: "allow" })`), so that every error it collects is a real one.
- A made app's page lives in an iframe: reach it with `page.frameLocator('iframe[data-made-app="<id>"]')`. A grocery card keeps only what is still to buy, so an item ticked there leaves it.

