# Notes: what was built, in what order

The history of the build in one long paragraph. The design, the owner's decisions and each step's as-built notes are in `docs/mini-app-contract.md`; `AGENTS.md` says in three lines where things stand.

1. App shell, deployed behind Cloudflare Access.
2. Mini-app contract, storage, settings and shared UI components.
3. Template and scaffold command.
4. Grocery list mini-app.
5. Scheduler, then the GitHub trending mini-app.
6. The assistant: Hearth as a connector for Claude.

Items 2 to 4 follow `docs/mini-app-contract.md`: the agreed design (section
A), the owner's decisions at its top, and fifteen build steps (section B),
each marked there once built. Built so far: step 1, the SDK package skeleton;
step 2, the UI kit in the SDK; step 3, the shared contract and the database
tables for apps in spaces; step 4, the server's registry of apps and the
routes that add an app to a space, remove it, bring it back and delete its
data; step 5, `defineServer` in the SDK, the store behind `ctx.db` and the
routes that run an app's queries and mutations; step 6, an app's
settings: the two routes that read and save them, and `ctx.settings`;
step 7, the build pipeline: `hearth-apps sync` and `check`, the lists of
apps a build holds, the import scan and `@hearth/sdk/eslint`; step 8,
widgets and pages in the shell: `appHooks`, `<AppScope>`, the dashboard's
cards and the app page; step 9, the Apps page (add, remove, each
person's switch and pin, and the route behind them) and the settings dialog
drawn from a manifest; step 10, groups, members and access: creating
and renaming a group, adding, inviting, changing and removing people,
invitations turned into membership on arrival, the policy of who may create
groups and invite, the owners' list, the access route, and a card for each
group in Settings with the member-by-app table; step 11, moving an app
with its data to another space: the route and the dialog on the Apps page;
step 12, deploy and CI: the deploy links the mini-apps to the SDK of
their release, offline, and builds them in, keeping the running release when
they were written for another SDK version, and CI builds every change with
`main` of `hearth-stones`; step 13, the setup of `hearth-stones` (its
`package.json` with the link to the SDK, lockfile, `tsconfig.json`,
`eslint.config.js` and CI), `@hearth/sdk/testing` with `testApp`, which
runs an app's own tests against the real store, and the commands
`hearth-apps test` and `hearth-apps dev`; step 14, the template and
the scaffold command: `hearth-apps new <id>` (`pnpm new <id>` in
`hearth-stones`) makes a new mini-app as a copy of the sample checklist,
which passes `check` untouched; and step 15, the grocery list, the first
mini-app of `hearth-stones` (`grocery/` there), which the people of a space
share, with tests of its own and an end-to-end test here of two family
members sharing one list (`e2e/mini-apps`, `pnpm e2e:mini-apps`). Items 2
to 5 are built. Item 5 follows section C of the same
document: the owner's decisions 8 to 15 at its top, the design of jobs,
`ctx.fetch` and the scheduler, the GitHub Trending app, and eleven build
steps, C1 to C11, each marked there once built and once reviewed. All
eleven are built and reviewed (the independent review's fixes are in the
as-built notes of the steps they concern): C1, the
hosts an app's jobs may fetch from (`network` in the manifest, checked by
`manifestSchema`), which the dialog that adds an app names, and the SDK's
version 0.1.1; C2, jobs in the SDK (`app.job` beside the queries and
mutations, a job's `ctx` with `fetch`, `read` and `write`, `FetchError`,
`SpaceSettingsOf`, `JobName`), checked when the server starts and by
`hearth-apps check`, which also refuse hosts in an app without a job;
C3, `ctx.fetch` itself (`packages/server/src/apps/fetch.ts`): the rules
every request meets, the pace that keeps requests to one host 6.5
seconds apart across the server, Node's fetch as the way out, and the
file of stand-in answers that `HEARTH_FETCH_STANDINS` names for
end-to-end tests; C4, running a job
(`packages/server/src/apps/jobs.ts`): migration 3's table `app_jobs`, a
run claimed, run with its `ctx` and its five minutes, and recorded with
the backoff and the jitter, and the work behind asking for a run and
reading a job's status; C5, the scheduler
(`packages/server/src/apps/scheduler.ts`), which the server
(`packages/server/src/serve.ts`) starts once it listens: due jobs one
at a time across the server, the one that fell due first first, a sleep
of at most 30 seconds that adding an
app or bringing one back cuts short, and a stop that ends the run going
on before the database closes; and `HEARTH_JOBS`, which switches jobs
off, as the deploy's trial start and every end-to-end server without
stand-ins do; C6,
a job's two routes (`GET .../jobs/:job`, its status for anyone who can
see the app, and `POST .../jobs/:job/run`, a run asked for with edit, at
most one every 5 minutes, or 5 seconds with stand-ins), `jobStatusSchema`
and `jobStateOf` in `@hearth/shared`, and `useJob` in `appHooks`, which
`<AppScope>` fills: the status, read every 3 seconds while a run is going
on or asked for, the app's queries read again when a run went well, and
`run()`; C7, jobs in an app's own tests: `runJob` on the world of
`testApp`, which runs a job through the scheduler's own code while a
function of the test answers what it fetches, and a person's `job` and
`requestRun`, the status as `useJob` shows it and a run asked for; C8,
a sample app with a job, end to end: `packages/fixture-apps/headlines`,
whose job fetches a sample news feed every hour and whose widget shows
the headlines, "Updated N min ago", "Refresh now" and the failed state,
with tests of its own, and in `pnpm e2e` the owner's and Lin's copies of
the server running their jobs over one file of stand-in answers; C9,
in `hearth-stones` (`trending/` there), GitHub Trending's data, job and
card: a job that searches GitHub every hour for the new repositories with
the most stars by day, week and month, for every language and each one
the space follows, a deny-list against spam and the space's Hide list,
and a widget with the first five of each person's own range, with tests
of its own (`hearth-stones` declares SDK `^0.1.1` from then on); C10,
in `hearth-stones` too, the trending app's page: "Updated N min ago" and
"Refresh now", the banner when a refresh failed with "Try again", the
range control and the chips of the languages the space follows, the list
with rank, link, description, language, stars, forks and age, and "Hide",
"Undo" and "Hidden (n)" for edit access; and C11, its end-to-end test
here (`e2e/mini-apps/trending.spec.ts`): the owner and Lin on the copies
of `pnpm e2e:mini-apps`, which now run their jobs over one file of
stand-in answers (`MINI_APPS_STAND_INS`) that plays GitHub's search, from
a first refresh that fails to one GitHub turns down. The document's
sections D and E are the questions behind decisions 1 to 5 and the risks.
Item 6 follows section F, after them: the owner's decisions 16 to 20 at its
top, then the design: each person adds Hearth to their own Claude as a
custom connector, and Hearth answers on an MCP endpoint at the server's own
address with `/mcp` (`POST /mcp`, through the official MCP SDK), signed in by Cloudflare
Access's Managed OAuth; the apps' queries and mutations are the tools, as
the signed-in person, with a level per space (Off, Read only, Read and
change) that its owners set, and apps they leave out. Four build steps, F1
to F4, are marked there once built and once reviewed. Built so far: F1,
the switches (migration 4, `assistant` in `VISIBLE`, the level's route and
`assistant` in the access route, the session and the owners' list); F2,
the endpoint (`POST /mcp` on `@modelcontextprotocol/server`, the tools, their
calls through `callApp` and the limits); F3, the Assistant card in
Settings; and F4, the end-to-end test (`e2e/assistant.spec.ts`) and the
guide (`docs/self-hosting.md`, section 10). All four are built and reviewed
(the independent review's fixes are in the as-built notes of the steps they
concern). Nothing has talked to the real Claude or to a real Access
application with Managed OAuth: that is the owner's first try, after the
deploy, and section 10 of the guide is marked as untried until then.

In November 2026 the owner chose to remove the connector, since each person's own model in Hearth's chat (`docs/platform.md`) does what it did: the endpoint at `/mcp` and its tools, the Assistant card's address and "Add to Claude", the end-to-end project `assistant` and section 10 of the guide went, and the switches of F1 stay, set on the Assistant card, to govern that model in the chat.

Also in November 2026 the owner removed the mini-apps framework that items 2 to 5 had built, once its three apps had moved to built-in apps of the platform (`docs/platform.md`): every app is now made in Hearth, a page in the browser's sandbox that the server never builds or runs (the platform's answers 3 and 4), so the SDK's server side, hooks and testing, `hearth-apps`, the sample apps, the build-time registry, the jobs and their scheduler, and the deploy's repositories of mini-apps went, while what made apps use (installs, access, the store, settings, the outbound fetch, the manifest rules, the UI kit and every table of the database) stayed.
