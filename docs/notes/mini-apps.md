# Notes: the SDK, `hearth-apps` and the sample apps

`packages/sdk` (what mini-apps are written against, the UI kit, the `hearth-apps` command), `packages/fixture-apps`, how a build takes its apps, and an app's own tests.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- Which mini-apps a server holds is decided when it is built, by
  `HEARTH_APPS_DIR` at that moment: one folder, or several separated like
  `PATH`, a relative one read from the root of this repository. The running
  server reads no apps folder. A plain `pnpm build` holds none. The deploy
  script passes the release's own copy of the mini-apps
  (`releases/<time>/hearth-stones`, from `APPS_REPO`), after linking it to
  the release's SDK with `pnpm install --frozen-lockfile --offline`; it logs
  what the build holds from sync's line "this build holds ...".
- `hearth-apps sync` writes three files that are not in Git:
  `packages/server/src/apps/registry.generated.js`,
  `packages/web/src/apps/registry.generated.js` and
  `packages/web/src/apps/sources.generated.css`. Only `main.ts` and
  `main.tsx` import the lists; their types are the `registry.generated.d.ts`
  beside each, which is in Git. Type checking, lint and unit tests need
  none of the three, so `pnpm check` works on a fresh checkout. Building one
  package by itself does not: run `pnpm apps:sync` first, or `pnpm build`.
- The server's tests do not read the generated list. They pass
  `FIXTURE_APPS` (`packages/server/src/testing.ts`), written by hand; a test
  (`src/apps/fixtures.test.ts`) fails when it differs from the folders in
  `packages/fixture-apps`. Add a fixture app in both places. A made-up app
  given beside `FIXTURE_APPS` must not take a sample app's ID (`checklist`,
  `feed`, `headlines`): `createRegistry` refuses an ID twice. The tests of
  `hearth-apps` name the sample apps too (`sync.test.ts`, `cli.test.ts`,
  `import-scan.test.ts`).
- `@hearth/sdk/web/scope` is for the framework: the import scan refuses it
  in a mini-app (only the exact names in `import-scan.mjs` are allowed).
  The hooks of `appHooks` are one shared object whatever the type argument,
  so they hold no logic; everything is in `<AppScope>`.
- `packages/sdk/tools` and `packages/sdk/bin` are plain JavaScript that Node
  runs before anything is built: no TypeScript syntax, and no import from
  `src`. They are type-checked through JSDoc (`allowJs` in the SDK's
  `tsconfig.json`). `APP_FOLDER_PATTERN` in `sync.mjs` repeats
  `APP_ID_PATTERN` for that reason; a test compares them.
- What a file of a mini-app may import is decided in one place,
  `scanApp` in `packages/sdk/tools/import-scan.mjs`. `hearth-apps sync` runs
  it before every build and the ESLint rule `hearth/mini-app-imports` runs
  the same function, so change the list there and nowhere else. A file's
  side follows from who imports it (`widget.tsx` and `page.tsx`,
  `server.ts`, `manifest.ts` on both); only imports that survive compiling
  count, and `import { type X }` survives. The scan skips `node_modules`
  and names that start with a dot, so it refuses an import that leads into
  either: one function, `isUnread`, says what is skipped and what is
  refused.
- `hearth-apps` ends with status 3 for exactly one thing: a folder of apps
  that declares another SDK version (`hearth.sdk` in its `package.json`)
  than `packages/sdk/package.json` has. Every other problem is status 1.
  Two places read it. The deploy script reads it from `pnpm build`, which
  starts with `pnpm apps:sync &&` and so ends with sync's status (pnpm
  passes it on; a test in `packages/sdk/tools/cli.test.ts` checks both): it
  keeps the running release and does not build those commits again (stage
  `sdk` in `state/failed`). The `mini-apps` job in CI reads it from
  `hearth-apps check` and passes with a notice; the CI of `hearth-stones`
  fails on it with a note to merge the SDK change here first. `test` and
  `dev` end with it too, from sync's checks, never from vitest's or the dev
  servers' own status, and `new` from the same handshake, for the folder
  it would make an app in. Status 2 is for a command the tool does not
  know, or one given the wrong number of arguments. Keep `build` starting
  with sync, and keep the status.
- A test that runs `hearth-apps` or `sync()` passes `--out` (or `out`) with
  a temporary folder, as `packages/sdk/tools/cli.test.ts` does, also through
  `pnpm check --out`. Without it the test rewrites this checkout's generated
  files. `test` writes nothing; `dev` refuses `--out`, so its unit tests
  (`tools/dev.test.ts`) call `dev()` with `out` and with the start of the
  servers replaced. `new` writes none of the generated files and ignores
  `--out`, but it writes an app into a folder of mini-apps, so its tests
  make apps only in repositories they made up. Those repositories
  (`tools/test-repos.ts`) lie outside the checkout, linked to the SDK, as
  `hearth-stones` does; `setUpStones` there sets one up exactly as
  `hearth-stones` is (`STONES`: keep its files as `hearth-stones` has
  them), beside a folder named `hearth`, and installs it with the real
  `pnpm`. The tests of its `pnpm dev` put a stand-in for this checkout in
  that folder, so that they start no real dev servers and write no lists
  here.
- `hearth-apps new <id>` (`packages/sdk/tools/new.mjs`) copies
  `packages/fixture-apps/checklist` as it is at that moment, so a change to
  the sample checklist reaches every app made after it: keep it a complete
  app that passes `check`, in both languages. The copy changes only the
  folder's name, the test file's name, two texts, the package's name and
  the README, which it writes new. The two texts, `id: "checklist",` in
  the manifest and `describe("checklist",` in the tests, must each be in
  the checklist exactly once; change `new.mjs` together with them, or
  `new` stops and `tools/new.test.ts` fails. It refuses a folder that
  sync would not take apps from (the same `handshake`, so status 3 for
  another SDK version), more than one folder, the `hearth` checkout itself
  and any name that is taken, and writes nothing then.
- A mini-apps repository installs nothing but a link to the SDK, so what it
  needs to be checked is a dependency of `@hearth/sdk`: `typescript`,
  `eslint`, `@eslint/js`, `typescript-eslint`, `@types/react`, `vitest`.
  `packages/sdk/tsconfig.app.json` leads `react` to the SDK's copy of
  React's types and `vitest` to the SDK's vitest for the same reason, and
  `resolve.dedupe` in `packages/web/vite.config.ts` gives an app the web
  app's React; without it a build with apps fails.
- An app's tests run inside this repository: `hearth-apps test` (and the
  fifth stage of `check`) starts `packages/server`'s vitest with
  `packages/server/vitest.apps.config.ts`, which reads the apps to test
  from `HEARTH_APP_TESTS` (set by the command; without it the file refuses
  to run) and whose setup file installs `createTestApp`
  (`src/apps/app-testing.ts`) for `testApp`. Its `vitest` import resolves
  to vitest's own copy whatever imports it, and `@hearth/sdk/testing`
  through the app's link to the SDK; both sides reach the same files, so
  the hand-over works. `vitest` started by hand in a mini-apps repository
  has no store: `testApp` then throws and says so. The command runs them
  with `TZ` set to `Asia/Shanghai` (`APP_TESTS_TIME_ZONE` in
  `packages/sdk/tools/test.mjs`), 8 hours from UTC, whatever zone it runs
  in, so that what an app keeps cannot follow the server's time of day
  unnoticed (GitHub Trending's dates are UTC's); `tools/cli.test.ts`
  holds it to that.
- `testApp` from `@hearth/sdk/testing` goes through the functions the
  routes use (`callApp`, `readAppSettings`, `changeAppSettings`,
  `jobStatus`, `requestRun`) and sets up its world with the ones that
  create groups, add people and change access, so a change to how the
  server answers reaches an app's tests by itself. Its `runJob` runs a job
  through `runOnce` with `force`, as the scheduler does, the rules of
  `ctx.fetch` in front of the test's own function (`standInTransport`),
  unpaced. Do not give it a second way of answering a call or of running
  a job. A stand-in's answer is held to the stand-in file's rules by the
  same schema (`standInAnswerProblem` in `fetch.ts`); one that breaks them
  rejects `runJob`, a test's mistake, while a run that fails resolves with
  `{ ok: false, error }`. While a run is going on in a world, a status is
  read at the moment the test gave that run, so a run given a time long
  past still shows as running. `createTestApp` takes a third argument,
  `TestWorldParts` (`db`, `now`, `clock`), for the framework's own tests
  only: `testApp` never passes it, and an app's tests get a new database,
  the time of day and the process's clock. It is not the `testApp` of
  `packages/server/src/testing.ts`, which builds the Hono app for the
  framework's own tests.
- `@hearth/sdk/testing/host` is for the framework, like
  `@hearth/sdk/web/scope`: the import scan refuses it in a mini-app.
- `hearth-apps dev` runs `pnpm dev` in this checkout with `HEARTH_APPS_DIR`,
  `HEARTH_AUTH=dev` and an owner (`you@example.com` unless
  `HEARTH_OWNER_EMAIL` is set). It starts it in a process group of its own
  and sends a stop signal to the whole group (`startDevServers` in
  `packages/sdk/tools/dev.mjs`): pnpm does not pass a signal on to the
  shell and `concurrently` below it, so signalling pnpm alone leaves both
  servers running. It also stops the group once the process that started
  it is gone (checked every second). In a mini-apps repository the `dev`
  script is `exec hearth-apps dev`: pnpm passes SIGTERM and SIGINT only to
  the shell it runs a script in, and that shell (dash, as `/bin/sh` on
  Debian and Ubuntu) keeps an interrupt to itself and dies of a terminate
  signal alone; `exec` puts the command in its place. pnpm dies of SIGHUP
  or SIGKILL without passing anything on, which is what the check of the
  parent is for. One Ctrl+C then reaches the command twice at once (from
  the terminal and from pnpm), and it passes the same signal on only once
  within half a second: the servers would take the second for another
  Ctrl+C, and tsx would kill the server before it has closed its database.
  `tools/dev.test.ts` holds all of it to that, through the real `pnpm dev`
  of such a repository: each signal sent to pnpm alone frees the stand-in
  servers' port, and a Ctrl+C reaches them once. The ports 4310 and 5173
  are fixed, so a dev server already running, even one left from another
  session, makes it fail to listen.
- A mini-app folder under `packages/fixture-apps` is held to the rules of
  every mini-app by `pnpm lint` (`miniAppBoundary` in
  `packages/sdk/tools/eslint-boundary.mjs`): the imports the scan allows,
  no `fetch`, `process`, `localStorage`, `eval` or `Function`, and no
  comment that switches a rule off. Server tests import a fixture's
  manifest and server file by relative path.
- The card sizes are listed in `@hearth/sdk` and again in `@hearth/shared`:
  the SDK imports no other Hearth package, and the API contract does not
  depend on the SDK. `packages/web/tests/contract.test.ts` fails when the
  lists differ.
- `SDK_VERSION` in `packages/sdk/src/index.ts` must equal `version` in
  `packages/sdk/package.json`; a unit test fails otherwise. Below 1.0, a
  breaking change to the SDK's types or to the manifest schema raises the
  minor version, and an addition the patch version: 0.1.1 added `network`
  to the manifest. A mini-apps repository whose apps use an addition
  declares that version (`^0.1.1`), which an older SDK refuses with status
  3; one that declares `^0.1.0` still fits 0.1.1. `packages/fixture-apps`
  declares `^0.1.1` since C8, whose headlines name a host, and
  `hearth-stones` since C9, whose GitHub Trending names `api.github.com`:
  its CI, which checks out `main` here, fails with status 3 until this
  repository's section C is merged, so merge here first. Section C adds to
  the SDK in C2, C6 and C7 without raising it again, since no repository
  of mini-apps declares 0.1.1 before C9: the sample apps lie beside the
  SDK they are built with.
- The SDK's type tests (`expectTypeOf`, `@ts-expect-error` in
  `packages/sdk/src/index.test.ts` and `server.test.ts`) fail in
  `pnpm typecheck`, not in the test runner.
- A manifest has two descriptions that must agree: the types in
  `packages/sdk/src/index.ts` and the schema in `manifest-schema.ts`. Change
  both. The schema holds what the types cannot: `network` is 1 to 10
  lower-case DNS names of two or more labels, the last letters only (so
  no scheme, port, path, wildcard or IP address), none twice and none of
  the local network (`localhost`, `*.localhost`, `*.local`, `*.internal`,
  `home.arpa` and below); it counts the hosts itself, because zod's
  `.max()` on a list also measures a text given in its place.
  `@hearth/sdk` itself must keep importing nothing (it ends up in the web
  bundle with every manifest); zod stays in `manifest-schema.ts` and
  `server.ts`.
- Icon and colour names are listed in the SDK. A new icon also needs its
  Lucide icon in `packages/sdk/src/web/icon.tsx` (a type error until then); a
  new colour needs a `--hearth-app-*` token in light and dark (the contrast
  test fails until then).
- What `packages/sdk/src/web/index.ts` exports is a promise to mini-apps in
  other repositories. Changing a component's props, removing one, or renaming
  a Tailwind token class in `packages/web/src/styles/index.css` is a breaking
  change to the SDK. Components only the shell needs stay in
  `packages/web/src/components`.
- The SDK has two type-check projects, because only the kit may use the
  browser: `packages/sdk/tsconfig.json` (everything but `src/web`, no DOM
  types) and `packages/sdk/src/web/tsconfig.json`. Its unit tests likewise
  run as two vitest projects, Node and jsdom.
