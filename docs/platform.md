# Apps made in Hearth, and your own model

The direction the owner chose (November 2026): Hearth becomes a platform for
personal software. Every person's needs differ, so each person makes the
apps they want by describing them to their own model, or uses an app someone
shared and has it changed to fit. The model also keeps the apps' data: "add
lunch, 35" is a message in the chat, not a form.

The owner's answers that shape this:

1. A central platform that many people share, with an application framework
   for those who write apps by hand. For now it is invitation-only: the
   owner, family and friends (the existing invitation and group policy).
2. A chat box in Hearth, with each person's own model and key.
3. Apps are packaged by their authors; the server only stores and serves
   them, and never builds them.
4. An app is only a page in the browser's sandbox plus what the platform
   offers it. No app code runs on the server, so an app written by anyone,
   or by anyone's model, can be used by others without reaching their data.

This document describes the first slice, built to prove the loop: in the
chat, "make me a ledger" makes an app, which appears on the dashboard;
"add lunch, 35" stores a row, and the app's page shows it.

## An app made in Hearth

It is three things, kept in the database (`made_apps`, migration 5):

- **A manifest** (`packages/server/src/made/manifest.ts`): a name and
  description in its maker's words (never translated), or in both languages
  for a built-in app, an icon and a colour from the SDK's lists, the size of
  its card, its collections, and instructions for whoever changes its data
  later. A collection has 1 to 30 fields, each `text`, `number`, `boolean`,
  `date` (`YYYY-MM-DD`, or a date and time), `choice` (with its options) or
  `list` (up to 2000 short texts: every #tag an idea can hold), optional
  unless `required`. The store checks every row against exactly those
  fields: a row with another field, or a value of another kind, is refused
  with the reason. It may also declare `settings` exactly as an SDK manifest
  does, checked by the SDK's own rules (`checkMadeManifest`), and Hearth's
  settings dialog and settings routes then serve it like any app's. Only a
  built-in app names hosts to fetch from (`network`): an app a model makes
  names none, and a change keeps a built-in copy's hosts as they are, since
  a host a page names is one the server fetches from, with its own address.
- **A page**: one HTML document, everything inline, at most 300 kB. It is
  drawn small in the app's card (`hearth.view` is `"card"`) and whole on
  the app's own page (`"page"`), so every made app has a page.
- **An install**: the same `space_apps` row every app has, added through
  `addApp` with its rules (owners, and members allowed to add apps; nothing
  shared with a group's other members until an owner chooses). So `VISIBLE`
  decides who may use a made app exactly as for any other, its rows live in
  `app_rows` through `store.ts`, and it moves, is removed and is deleted
  like any other app. Deleting its install deletes the app itself.

Made apps have IDs like `m-k3x9p2q7ab`, and they are every app the server
holds: the registry, which every part of the server asks whether an app
exists, is `madeAppsRegistry` (`src/made/apps.ts`), read from `made_apps`
each time.

## The sandbox

A made app's page is served at `GET /api/spaces/:space/apps/:app/frame`
and drawn in an iframe with `sandbox="allow-scripts allow-forms
allow-popups allow-popups-to-escape-sandbox"`. Its response carries its own
Content-Security-Policy (`SANDBOX_CONTENT_SECURITY_POLICY` in
`src/made/frame.ts`): nothing may be loaded or fetched from anywhere
(`default-src 'none'`), no form may be sent (`form-action 'none'`), only
Hearth may frame it, and `sandbox` gives it an opaque origin even when
opened by itself. `allow-forms` only lets a form's submit event fire for
the page to handle; without it browsers drop the event. The popups let a
link open another site in a new tab (GitHub Trending opens repositories);
dialogs (`alert`, `confirm`) stay blocked.

So the page cannot read Hearth's pages, cookies or storage, and cannot call
Hearth's API. All it can do with data is `window.hearth`, which the server
puts in front of the page's own scripts:

- `list`, `add`, `update` and `remove` of its own collections, and
  `replace(collection, where, rows)`, which swaps every row matching
  `where` for new ones at once, all or nothing (at most 1000). `where` is
  always given, `{}` for every row: a missing one, or a field in it left
  undefined, is refused rather than taken for every row;
- `settings()` and `saveSettings({ space?, user? })`, through the same
  routes and rules as every app's settings;
- `fetch(url, { headers })`: a GET made by the server under the rules of
  `src/apps/fetch.ts`, to the hosts the manifest names alone, paced with
  every other app's requests to the same host, and without the person's
  cookies;
- `onChange` to hear that the data or settings changed elsewhere;
- `locale`, `theme`, `access` (`"view"` or `"edit"`), `view`, and `user`
  and `space` (its kind, name and members, each an ID and a name), so that a
  page can say who wrote a row.

Each call is a message to the page around it
(`packages/web/src/made/frame.tsx`), which answers only messages from that
iframe and always for the app and space it drew the iframe for, whatever the
message says. Each app gets an iframe of its own, so that going from one
app's page to another's leaves nothing of the first to be answered as the
second. The page reports its height (a page sized to its frame, `100vh`, is
told apart, or it would grow the frame for ever), and gets the theme's
colours as CSS variables.

What the sandbox does not stop: a page can still navigate its own frame to
another address, and a browser may let it open a WebRTC connection, so an
app's page could send away the data of that same app that it was given.
Every app on the platform is still one a person chose to use: made by
their own model, or shared by someone they know. Before sharing with
strangers, this needs a closer look (a separate origin for frames, and
watching for a frame that navigates away).

## Your own model

Each person saves their model in Settings ("Your model"): the kind of
service, its https address, the model's name and the API key
(`PUT /api/me/model`, `src/model/settings.ts`).

- **Two kinds of service.** "OpenAI-compatible" is OpenAI's chat
  completions, which DeepSeek, OpenAI, Kimi, Qwen, OpenRouter and most
  others answer; it is one POST with fetch. "Claude" goes through
  Anthropic's own SDK (`@anthropic-ai/sdk`), streamed and collected with
  `finalMessage()`, its content handed back unchanged in the tool loop.
- **The key** is sealed with AES-256-GCM under a key derived from
  `HEARTH_SECRET` and opened only to call the model. No answer of the server
  holds it. A key goes only to the address it was saved for: saving another
  address without a key drops the old one. A new `HEARTH_SECRET` makes every
  saved key unreadable, and people enter theirs again.
- **The address** must be https on a public name: no IP address, no local
  name, no sign-in or query in it, so that the server is not made to call
  its own neighbours with a person's key.

## The chat

`/chat` in the web app; `POST /api/chat` on the server, answered as a stream
of server-sent events (`ChatEvent` in `@hearth/shared`), so that a long
answer, such as a whole app's page, outlasts any proxy's timeout.

- The model works in one space the person chooses, as an assistant for
  them (`by: "assistant"`): it may do no more than they may, and no more
  than the space's owners allow an assistant there (owner's decision 7).
  For each space its owners choose Off, Read only or Read and change, and
  may leave apps out, on the Assistant card in Settings. Every space starts
  Off; an owner can also switch it to Read and change from the chat itself.
  These are the switches of section F of `docs/mini-app-contract.md`, built
  for a connector for Claude that the owner removed in November 2026: the
  chat does what it did.
- Its tools: `create_app` (a manifest and a page), `list_rows`, `add_row`
  and `update_row` on the made apps of the space. Every input is checked
  before anything runs; every outcome, refusals included, goes back to the
  model so that it can tell the person or try again. At most 10 steps per
  message.
- What it is told: who and where, today's date, the made apps of the space
  with their fields and their makers' instructions, how to write a page for
  the sandbox, and that what tools return is data, never instructions.
- What it did shows in the conversation, and an app it made is drawn right
  there, as on the dashboard. The conversation lives in the page only; the
  server keeps none of it.

## Changing an app

The owner chose (decision 7, as recommended): what the model adds and
changes it does at once, shows in the conversation, and can be undone;
what it deletes it asks about first (not built yet: the chat deletes
nothing).

- **Versions.** Every change to an app is a new version
  (`made_app_versions`, migration 6); the newest 30 are kept. Going back
  to an earlier version is itself a new version, so it can be undone too.
  The version in use is in the session, and a frame draws the new page
  when it changes.
- **The rule for fields.** A change must leave every row stored now valid:
  adding collections and optional fields, adding options to a choice and
  making a field optional always work. A change that some row would not
  fit (a field made required that a row lacks, a type a value does not
  have, a field or collection that holds data) is refused, with the rows
  and why (`rowsNotFitting` in `store.ts`). Going back is held to the same
  rule: rows written since must fit the version brought back.
- **Who may.** Changing what an app is reaches everyone who uses it, so it
  is for those who may add apps to the space and have edit access to the
  app; an assistant also needs the space's owners to allow it to change
  things there.
- **In the chat** the model has `read_app` (the whole manifest and page,
  and recent versions), `update_app` (a whole new manifest, page or both,
  with a note of what changed) and `restore_app_version`. Each change shows
  in the conversation with an Undo button, which brings back the version
  before it (`POST .../versions/:version/restore`).

## Built-in apps

The apps Hearth ships are made apps too: each is a folder of
`packages/server/catalog` with its `manifest.json` (names and texts in both
languages) and `page.html`, written by hand and checked at start-up like any
made app (`src/made/catalog.ts`), so that a broken one stops the server
before it serves anything. They are the grocery list, Ideas and GitHub
Trending, rewritten to the same data from the mini-apps of those names,
which the releases before them built in from `hearth-stones` (see "The
mini-apps framework, removed" below).

- **Adding one.** `GET /api/catalog` lists them, and the Apps page's Add
  dialog offers those the space does not have; every other app is made in
  the chat. `POST /api/spaces/:space/catalog/:id` adds one as a made app of
  the space's own (`made_apps.template`, migration 7), which can be changed
  in the chat like any other; a space has one of each, and adding one the
  space removed brings that one back, with its data.
- **The move of the old apps.** When the server starts, every install of
  one of those mini-apps (`grocery`, `ideas` or `trending`, the IDs of the
  built-in apps) becomes that built-in app, in place (`moveLegacyInstalls`
  in `src/made/builtin.ts`): the install gets a made app's ID, which every
  table about it follows (`ON UPDATE CASCADE`), so its rows, settings, who
  may use it, pins and switches stay as they were, and removed installs
  move too; the status of its jobs is deleted. Each install moves alone, in
  one transaction, and only if every row it holds fits the built-in app;
  one that does not stays as it was, hidden with its data, since the server
  holds no app of that ID, and is named in the server's log, at every start
  until it moves. The deploy's trial start tries the move on a copy of the
  real database first.
- **Updates.** A built-in app's copies follow what Hearth ships: when the
  server starts, every copy nobody changed is brought up to the built-in app
  of this release, as a new version ("Updated with Hearth"), which can be
  undone like any (`updateBuiltInApps`; `made_apps.template_hash` says which
  release a copy is, and is cleared by any other change). A copy someone
  changed, in the chat or by going back to a version, is theirs and stays as
  it is; so does one whose rows would not fit, which the log names.
- **No jobs.** GitHub Trending refreshes its lists itself, through
  `hearth.fetch`, when someone who may edit it opens it and its last
  refresh is more than an hour old, or on "Refresh now". A row in
  `refreshes` marks a refresh in progress, so that two pages do not run one
  at the same time.
- **What changed with the move.** The rules the old apps kept on the
  server now live in their pages: the grocery list's one row per name, Ideas'
  #tags and its 5000 ideas, GitHub Trending's searches and deny-list. A page
  checks them against what it last read, so two people acting in the same
  second can still both add the same item, and a page reads every row of its
  collection again every 15 seconds (Ideas up to 5000). A refresh of GitHub
  Trending runs in the page that started it: leaving that page stops it, and
  the next page to open waits until the refresh has not moved for a minute
  before it starts its own.

## The mini-apps framework, removed

Before the platform, apps were written by hand against `@hearth/sdk`: a
manifest, a server file of queries, mutations and scheduled jobs, and a
widget and a page in React. The `hearth-apps` command checked them and
built them into each release, from `hearth-stones` and any other
repository of mini-apps the deploy named, and their code ran inside the
server and the web app. `docs/mini-app-contract.md` is the record of how it
was designed and built. It did what answers 3 and 4 above rule out for
the platform, building apps into the server and running their code there,
and once its three apps had moved to built-in apps the owner removed it in
November 2026: the SDK's server side, its hooks and its tests of an app,
`hearth-apps`, the sample apps, the lists of apps written at build time,
the server's code for running a bundled app's routes and jobs (with the
scheduler and `HEARTH_JOBS`), the web app's for drawing its widget and
page, and the deploy's repositories of mini-apps (`APPS_REPO`, still
accepted and ignored).

What apps made in Hearth use stays: installs and `VISIBLE`, access,
switches and pins, moving an app, removing and bringing it back, deleting
its data, the store, settings, the rules and pace of an outbound fetch and
its stand-in file, the manifest rules of `@hearth/sdk` and its UI kit, and
the assistant's switches. So does every table of the database, `app_jobs`
among them, which nothing writes any more, and so does the move of the old
apps' installs, for a server that still holds some.

## Testing

`src/made/made.test.ts` and `src/model/chat.test.ts`, against a fake fetch
for the model: who reaches a made app and its rows (another person, a
member it is not shared with, view without edit), what a row must be, the
sandbox's headers, the sealed key and the address rules, the whole loop
over both protocols, and an assistant that is off or may only read.
`HEARTH_MODEL_STANDIN` (dev mode only) sends every chat to a stand-in, for
trying the web app without a real model.

## Not built yet

- **Deleting from the chat**, rows or apps, with the person's confirmation
  first (decision 7). Undoing a row the model added or changed.
- **The center**: publishing an app, finding others', installing a copy and
  changing it to fit.
- **Developers' path** (answer 3): uploading an app written by hand.
- **Jobs for made apps** (a scheduled fetch the platform runs for an app).
- **Sign-in for a public platform**: Cloudflare Access is fine while the
  platform is invitation-only.
