# Notes: the end-to-end tests

The Playwright tests in `e2e`: the stand-in for the server, and the copies of the real server they share.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- Every app a server lists is made in Hearth, and so is every app the
  stand-in in `e2e/fixtures.ts` lists: its card and its page hold a
  sandboxed frame, which the stand-in fills with a small page of its own
  (`framePage`: the app's name in the language asked for, with the theme,
  view and version it was asked for on its elements). Its built-in apps are
  made up (`checklist` and `feed`, `BUILT_IN_IDS`), listed by
  `GET /api/catalog` (`catalog`, all of them unless a test says otherwise)
  and added with `builtInApp`. It answers adding one or bringing it back,
  removing, moving, switch and pin and the settings `PATCH`, bringing a
  removed app back (`PUT`) and deleting one for good (`DELETE .../data`,
  with its name), and records them in `appChanges`. A space's owners' list
  keeps the apps it removed, with their names, icons and colours: one drawn
  from the session until then is kept in `groups` from the first removal; it also keeps groups (the owners' list of each in
  `groups`, the people it knows in `people`, `ownAFamily` for a ready
  family) and records their changes in `groupChanges`. The owners' list of
  a space it was given none for, a personal one included, is drawn from the
  session. For the chat it answers the person's model (`model`, null until a
  test sets one), their conversations in each space (`chats`: listed, read
  and deleted, 404 for a space or conversation not theirs) and
  `POST /api/chat`, whose made-up model answers "Noted: " and the message,
  keeping both and recording the request in `chatRequests`. The person's
  answer to a request of the model's to delete
  (`POST .../confirmations/:id`) is recorded in `confirmationRequests` and
  kept in that request's entry of `chats`, so a reload shows it; a test
  writes such entries itself, and `confirmationFailure` refuses answers.
- Removing an app keeps everyone's switches, pins and settings, and its
  data, and the end-to-end tests against the real server share one server.
  Deleting an app for good (`DELETE .../data`) wants its name, which the
  owners' list gives (`name.en`), not its ID.
  A test there that changes them puts them back, or works in a group of its
  own, before it removes the app. Nothing deletes a space, so a group a test
  creates stays for the tests after it: give it a name of its own and do not
  count groups.
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
  so that a test can be two people on one server. Every copy answers the
  fetches of its apps from one file of stand-in answers beside that
  database (`STAND_INS`, `HEARTH_FETCH_STANDINS`), so it goes when the
  owner's copy starts: a test writes it whole with `writeStandIns` before it
  opens an app that fetches, such as GitHub Trending, and until then every
  fetch fails as the network would. No copy reaches a real host.
- The chat of every copy of the real server asks a stand-in model, never a
  real one: `e2e/model-stand-in.ts`, a small Node server that
  `playwright.config.ts` starts on `MODEL_PORT` (`e2e/servers.ts`, the port
  after Lin's) and every copy is given as `HEARTH_MODEL_STANDIN`, with a
  `HEARTH_SECRET` of their own that seals the keys the tests save (the same
  in every copy, so Lin's copy opens what the owner's sealed). It answers
  `POST /chat/completions` alone, with "Noted: " and the person's last
  message as the server sent it (Hearth's notes of answers to requests to
  delete included), calling no tool; except a message whose own words are
  "delete " and a text, to which it reads the rows of every app the system
  prompt lists (`list_rows`), asks to delete the first row one of whose
  fields is that text (`delete_rows`) and says "Asked before deleting "
  and the text. A test may save any OpenAI-compatible model
  in Settings (`https://api.example.com/v1`, a made-up key): nothing reaches
  that host.
- The tests against the real server are `real-server.spec.ts`,
  `chat-history.spec.ts` and `deleting.spec.ts` (`REAL_SERVER_TESTS`); they
  share the owner's preferences, model and spaces, so the "server" project runs them in one
  worker, one file after another. A test there that changes the owner's
  model, the assistant's switch of a space or its conversations puts them
  back when it ends.
- Playwright's `serviceWorkers: "block"` (the default in `playwright.config.ts`) runs a script in every frame that reads `navigator.serviceWorker`, which a made app's sandboxed frame refuses with a page error. A test that draws a made app and collects page errors allows service workers (`test.use({ serviceWorkers: "allow" })`), so that every error it collects is a real one.
- A made app's page lives in an iframe: reach it with `sandbox(page, appId)` (`e2e/fixtures.ts`), which is `page.frameLocator('iframe[data-made-app="<id>"]')`. A grocery card keeps only what is still to buy, so an item ticked there leaves it, at once when nothing else is left and before its tick is saved: read the server's rows after it with `expect.poll`.
- A fetch of an app's page that the server answers with an error, such as a 502 for a host that failed, is logged by the browser as a console error ("Failed to load resource"): a test that collects console errors expects that line.
- `pnpm e2e` builds the web app and the server itself, and runs every test in `e2e`. The tests of the mini-apps of another repository, `e2e/mini-apps` and `pnpm e2e:mini-apps`, went with the mini-apps framework in November 2026.
