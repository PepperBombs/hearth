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
- `e2e/mini-apps` tests apps of another repository, today the grocery
  list, GitHub Trending and Ideas of `hearth-stones`. That
  repository has no Playwright of its own (it installs
  nothing but the SDK's link). `pnpm e2e` leaves the folder out; `pnpm
  e2e:mini-apps` (`playwright.mini-apps.config.ts`) builds Hearth with
  those apps and starts the owner's and Lin's copies of the server on ports
  4183 and 4184 over a database of their own (`MINI_APPS_*` in
  `e2e/servers.ts`). Both run their jobs over one file of stand-in answers
  beside that database (`MINI_APPS_STAND_INS`), as in `pnpm e2e`.
  A file runs only when the folders hold the app it is
  named after, so CI's `mini-apps` job passes against a `hearth-stones`
  without that app. CI in `hearth-stones` does not run these tests: a
  change there to an app's texts or layout needs its file here changed
  with it, and shows first in this repository's next CI run. So does a
  change to GitHub Trending's searches: `trending.spec.ts` answers each
  search by the text of its `q` (the filters against spam, the fewest forks
  of its range, the language), those of the two languages the family
  follows first; then an entry that holds `language:` alone turns down the
  search for any other language, and a search no stand-in answers fails
  the run. The exact queries, dates and numbers of forks are the app's own
  tests' to hold. Its browsers follow a link to GitHub only into a stand-in
  page: a route on each context answers `https://github.com` itself and
  refuses every other host but the test's servers. Lin's browser is on a
  clock 8 hours from UTC, the owner's on UTC's. One check needs the
  server's 5 seconds between runs: the owner asks for a run once one has
  ended, and Lin's page and the owner's card must show "Refreshing…"
  before that run starts. `ideas.spec.ts` needs no stand-ins, since Ideas
  has no job: the owner alone first (an idea written on the card, then on
  the page #tags in two scripts, a search held back to see the timeline
  stay, dimmed, pin, edit, archive, delete), then the owner and Lin, who
  reads on her phone in Chinese and writes once the owner lets members
  edit. It reads the timeline as the text of each idea's first paragraph
  and names a tag's chip "#tag n". Do not run
  the two Playwright commands at the same time: both build into the same
  `dist` folders.
