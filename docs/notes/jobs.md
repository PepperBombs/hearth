# Notes: jobs, the scheduler and `ctx.fetch`

Scheduled jobs of mini-apps (`packages/server/src/apps/jobs.ts`, `scheduler.ts`, `fetch.ts`): how a run is claimed, run and recorded, what it may fetch, and the stand-ins that keep tests off the network.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- Jobs share one set of names with the queries and mutations
  (`app.routes`) but are never routes: `callApp` answers 404 for a job's
  name at `/q/` and `/m/`, and `QueryName` and `MutationName` leave jobs
  out (`JobName` names them). A job's function may be `async`; the `work`
  it gives `ctx.read` and `ctx.write` may not, and the types refuse a
  promise there (`NotAPromise` in `packages/sdk/src/server.ts`).
- A job runs through three functions in `packages/server/src/apps/jobs.ts`,
  and nothing else runs one: `claimRun` (one immediate transaction: the
  install is there, the job due or forced, no run holds it; it sets
  `run_id` and `run_until`, the start plus the 5 minutes and one more),
  the run (`runClaimed`, outside any transaction) and `recordRun` (one
  immediate transaction that finds the row by `run_id`, so it follows a
  move). `runOnce` does the three in order: the scheduler and `testApp`
  run jobs through it. A run ends at once when its 5 minutes are up (it
  failed, with the backoff), when the server stops it or when `ctx.read`
  or `ctx.write` is refused for the install (both recorded as nothing,
  the job due at once), and when work hands them a promise (it failed);
  its `ctx` stops working then, whatever the function goes on to do. The
  SQL of `app_jobs` is in `jobs.ts` alone; an app's rows are still read
  and written through `store.ts`.
- `ctx.read` and `ctx.write` make their store inside their own
  transaction, after checking there that the run's time is not up by the
  clock of the day and that the run still holds its install (`holder` in
  `jobs.ts`: the app's entry in the space the run started in, not
  removed, and the job's row holding this run's ID), as `resolveInstall`
  comes first for a handler. Keep both checks inside the transaction and
  before the work. A job's store records whoever added the app
  (`space_apps.created_by`) as the writer, with the time of the write, and
  refuses `list({ mine: true })`, since a job is no one (`StoreScope.job`
  in `store.ts`); a job's `ctx.settings` is the space's alone
  (`spaceSettingsFor`).
- What a run needs from around it is given (`RunWorld` in `jobs.ts`: the
  `Outbound` for `ctx.fetch`, a `Clock` for the time limit, the time of
  day, the randomness for the jitter, a signal for the server stopping),
  and the scheduler is given the same (`createScheduler`). Their tests
  give their own: `fakeClock` (`src/apps/test-clock.ts`, which
  `fetch.test.ts` uses too) moves only when told, and a transport written
  in the test answers. Keep job and scheduler tests that way: nothing in
  them waits for real time or reaches a network.
- The scheduler (`packages/server/src/apps/scheduler.ts`) is the only
  thing on a server that starts a run, and only `startServer`
  (`packages/server/src/serve.ts`) makes one, when `HEARTH_JOBS` is `on`
  (the default), starting it once the server listens; `createApp` starts
  none, so the server's tests run no job unless one asks. It asks
  `nextJob` (`jobs.ts`, the one query across spaces, which reads
  `space_apps` and `app_jobs` only) for the job that falls due first,
  runs it with `runOnce` when it is due, one at a time,
  and otherwise sleeps until it is, at most `LONGEST_WAIT_MS` (30
  seconds), so that a change made by another process sharing the
  database is seen within that. Its `wake` cuts the sleep short:
  `createApp` takes it as `wakeJobs`, and the route that adds an app or
  brings one back calls it, as does the route that asks for a run when
  the run was asked for (not during a run). On SIGTERM or SIGINT
  `serveHearth` calls `startServer`'s `stop`, which stops the scheduler
  first (the run going on ends at once, its job due again at the next
  start) while the server stops listening, then closes the database,
  within 5 seconds whatever holds things up (`STOP_LIMIT_MS`, on the clock
  it was given). `src/serve.test.ts` holds all of this to it: no scheduler
  with `HEARTH_JOBS=off`, a scheduler that starts only once the server
  listens (a job due before the start is not claimed until then, and never
  by a server that cannot listen), the stand-in file as the way out, the
  wake from both routes, the stop's order and its limit.
- Nothing automated starts a real server with jobs that may reach a real
  host. `HEARTH_JOBS=off` switches them off (`jobs` in the config, `on` or
  `off` only): `realServerCommand` (`e2e/servers.ts`) gives it to every
  copy of the server it starts without a stand-in file, and the
  deploy's trial start gets it from `deploy/hearth-deploy.sh`, which the
  deploy tests check (the made-up server writes `trial off` and `live
  unset` into `started-with` beside it). A test that needs jobs on a real
  server gives stand-ins instead: given a file, `realServerCommand` starts
  the copy with `HEARTH_JOBS=on` and `HEARTH_FETCH_STANDINS`, as
  `playwright.config.ts` does for the owner's and Lin's copies
  (`STAND_INS`) and `playwright.mini-apps.config.ts` for its two
  (`MINI_APPS_STAND_INS`), so that GitHub Trending's job runs there
  against stand-ins and never against GitHub. `pnpm dev`
  runs jobs against the real hosts their manifests name (owner's decision
  15): with `hearth-stones` in it, GitHub Trending searches the real
  `api.github.com` once it is added to a space, so give it stand-ins when
  that is not wanted, and never from anything automated.
- `requestRun` and `jobStatus` (`jobs.ts`) hold the checks of a job's two
  routes (`GET .../jobs/:job`, `POST .../jobs/:job/run`, in
  `apps/routes.ts`): 404 when `resolveInstall` gives null, the app has no
  server file or no job of that name, then 403 for a run asked for with
  view. A run asked for starts at once, or 5 minutes after the last one
  started, never sooner, and nothing changes during a run. The gap is
  `requestGapFor(config)`, which `createApp` hands the routes: 5 seconds
  (`STAND_IN_REQUEST_GAP_MS`) when `HEARTH_FETCH_STANDINS` is set, so
  that an end-to-end test can ask twice. Their answer's shape is
  `jobStatusSchema` in `@hearth/shared`.
- `ctx.fetch` is `fetchFor` in `packages/server/src/apps/fetch.ts`, in
  three parts. The rules, at every request: GET to https on the default
  port, no user name or password, a host the manifest lists exactly;
  `user-agent: Hearth` and only accept, accept-language,
  if-modified-since, if-none-match and `x-` names other than
  x-forwarded-* and x-real-ip; up to 3 redirects, on https to the same
  host; 20 seconds for each answer, its body included; 2 MiB of body,
  counted after decompression. Then the pace (`createPace`): requests to
  one host start 6.5 seconds apart across the whole server, the request
  a redirect leads to as well. Then a transport, one request and one answer
  with nothing followed: Node's fetch (`nodeTransport`, `redirect:
  "manual"`), or the stand-in file. A transport, or a body, that ignores
  its signal is not waited for. Its tests give a made-up transport, or a
  made-up `fetch` that returns real `Response` objects, and a `Clock`
  that moves when told: keep the rules tested that way, never against a
  real host. The promise `ctx.fetch` gives counts as handled from the
  start: when a run ends, every request of it still waiting rejects with
  `stopped`, and the job may no longer wait for it (one that failed on its
  first of two requests, or ran out of time). A promise the job makes of
  one (`ctx.fetch(url).then(...)`) is the job's: `serveHearth` logs it if
  it rejects unhandled. `jobs.test.ts` ("requests a run leaves behind")
  listens for unhandled rejections while runs end each way.
- `serve()` of `@hono/node-server` replaces the globals `Request` and
  `Response` with lighter classes of its own, and an answer of Node's
  fetch is no instance of those. `fetch.ts` asked the global what a
  `Response` is, so on a server that listened every `ctx.fetch` through
  Node's transport failed with "the transport gave no answer", whatever
  the host answered. No test saw it: made-up transports and a made-up
  `fetch` answer with `new Response`, made of the global of that moment,
  and every end-to-end server answers jobs from the stand-in file.
  `fetch.ts` now knows an answer by `PlatformResponse`, the class kept
  when the module loads, never by the global: keep it so, and keep
  `fetch.ts` loaded before anything listens. Do not switch the
  replacement off instead (`overrideGlobalObjects: false`): Hono's
  `bodyLimit` makes a `new Request` of the listener's own request, which
  only the listener's class can read, and every request with a body it
  has to count then ends in 500, as the end-to-end tests of the built
  server showed. A test in `serve.test.ts` holds the fix where it
  matters: while `startServer` listens, a job reads a real answer of
  Node's fetch from a listener on this machine. One in `fetch.test.ts`
  holds it with the global replaced. A test of Node's transport that must
  stand for a real server needs an answer of the real `fetch`, not
  `new Response`.
- `HEARTH_FETCH_STANDINS` names a JSON file whose stand-ins answer every
  `ctx.fetch` (`standInFile`), at once and unpaced, read again at every
  request, so a test changes the answers by writing it: write it whole,
  as a new file renamed into place. `loadConfig` refuses the setting
  unless `HEARTH_AUTH=dev`, which needs a loopback `HOST`, so a real
  server cannot have it, and the server warns when it is on. The rules
  still come first, so a stand-in opens no
  host the manifest does not list. A request no entry answers, and every
  request while the file is missing or not a list of stand-ins, fails as
  `network` with a message that says so.
