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
  description in its maker's words (never translated), an icon and a colour
  from the SDK's lists, the size of its card, its collections, and
  instructions for whoever changes its data later. A collection has 1 to 30
  fields, each `text`, `number`, `boolean`, `date` (`YYYY-MM-DD`, or a date
  and time) or `choice` (with its options), optional unless `required`.
  The store checks every row against exactly those fields: a row with
  another field, or a value of another kind, is refused with the reason.
- **A page**: one HTML document, everything inline, at most 300 kB.
- **An install**: the same `space_apps` row every app has, added through
  `addApp` with its rules (owners, and members allowed to add apps; nothing
  shared with a group's other members until an owner chooses). So `VISIBLE`
  decides who may use a made app exactly as for any other, its rows live in
  `app_rows` through `store.ts`, and it moves, is removed and is deleted
  like any other app. Deleting its install deletes the app itself.

Made apps have IDs like `m-k3x9p2q7ab`; `withMadeApps`
(`src/made/apps.ts`) adds them to the registry, so that every part of the
server asking whether an app exists finds them. The build's own apps keep
working as before, side by side.

## The sandbox

A made app's page is served at `GET /api/spaces/:space/apps/:app/frame`
and drawn in an iframe with `sandbox="allow-scripts allow-forms"`. Its
response carries its own Content-Security-Policy
(`SANDBOX_CONTENT_SECURITY_POLICY` in `src/made/frame.ts`): nothing may be
loaded or fetched from anywhere (`default-src 'none'`), no form may be sent
(`form-action 'none'`), only Hearth may frame it, and `sandbox` gives it an
opaque origin even when opened by itself. `allow-forms` only lets a form's
submit event fire for the page to handle; without it browsers drop the
event.

So the page cannot read Hearth's pages, cookies or storage, and cannot call
Hearth's API. All it can do with data is `window.hearth`, which the server
puts in front of the page's own scripts: `list`, `add`, `update` and
`remove` of its own collections, and `onChange` to hear that the data
changed elsewhere. Each call is a message to the page around it
(`packages/web/src/made/frame.tsx`), which answers only messages from that
iframe and always for the app and space it drew the iframe for, whatever the
message says. The page reports its height, and gets the theme's colours as
CSS variables.

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
  Every space starts with the assistant off; an owner switches it on, from
  the chat itself or in Settings.
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

## Testing

`src/made/made.test.ts` and `src/model/chat.test.ts`, against a fake fetch
for the model: who reaches a made app and its rows (another person, a
member it is not shared with, view without edit), what a row must be, the
sandbox's headers, the sealed key and the address rules, the whole loop
over both protocols, and an assistant that is off or may only read.
`HEARTH_MODEL_STANDIN` (dev mode only) sends every chat to a stand-in, for
trying the web app without a real model.

## Not built yet

- **Changing and deleting apps from the chat** (`update_app`). A changed
  field can leave stored rows that no longer fit, which the store refuses to
  read: this needs a rule for changing fields first. Rows cannot be deleted
  from the chat yet either: decision 7 said the assistant confirms every
  change, and the chat does not ask yet. Which changes need asking is the
  owner's to decide.
- **The center**: publishing an app, finding others', installing a copy and
  changing it to fit.
- **Developers' path** (answer 3): uploading an app written by hand.
- **Jobs for made apps** (a scheduled fetch the platform runs for an app).
- **Made apps over MCP**: Claude through the connector does not see them yet.
- **Sign-in for a public platform**: Cloudflare Access is fine while the
  platform is invitation-only.
- **The old way of building apps in**: the three apps of `hearth-stones` are
  still compiled into the build. Once made apps can do what they need, they
  move over and that pipeline goes.
