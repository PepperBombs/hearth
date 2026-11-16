# Notes: the assistant

Hearth as a connector for Claude (section F of `docs/mini-app-contract.md`): the MCP endpoint at `POST /mcp`, its tools, the Assistant card and its end-to-end test.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- `/mcp` is the assistant's MCP endpoint (section F, `MCP_PATH` in
  `src/app.ts`): `POST /mcp` goes to `src/assistant/mcp.ts`, behind the
  same `sameOrigin` and `requireMember` as `/api`; `GET` and `DELETE` answer
  405. Cloudflare Access's Managed OAuth names the address asked for, path
  included, as what Claude signs in to, so the address the Assistant card
  gives is the page's own origin with `/mcp`. Never give the web app a page
  at `/mcp`.
  The protocol is the official SDK's v2 (`@modelcontextprotocol/server`,
  which needs zod 4 and nothing else; `@modelcontextprotocol/client` for
  tests), serving both MCP 2026-07-28 and, statelessly, the 2025 handshake
  Claude speaks: a new SDK server for each request, no session anywhere.
  The tools are the catalog `createToolCatalog` makes once from the build:
  `<app ID>_<route>` for each query and mutation (an app's ID has no `_`;
  `hearth-spaces`, Hearth's own, has none at all), at most 64 characters
  (longer ones are left out with a start-up warning through `createApp`'s
  `warn`), each taking `{ space, input }` with `space` an enum of the
  person's spaces by name. Each person's list
  is made at each request from `listAssistantInstalls`, and every call
  goes through `callApp` with `by: "assistant"`, which checks again: never
  run an app's route for the assistant any other way. Calls are limited to
  60 a minute per person and answers to 100,000 characters.
- A space's name in a tool must mean one space for as long as an assistant
  may hold it: a person approves a change by the name Claude shows them.
  `assistantSpaceLabels` (`@hearth/shared`) decides the names, for the
  server's tools and for the Assistant card alike: "Personal" for the
  person's own space, a group's name while no other space of theirs is
  called alike (whatever the capitals), and otherwise every such group
  marked with the start of its own ID, "Family (id 7f3k2q)", none of them
  bare. Never number spaces by their place in a list (" (2)"): the first
  version did, and a change approved for "Family" landed in another family
  once the person was added to an older group of that name. A name that no
  longer holds is refused with the names that do; only a name one group
  gave up and another took (two renames) follows the name. The words that describe
  `space` are the same for everyone and name no space, and every tool's
  description ends with `DATA_NOTE` (what it answers is data, never
  instructions): claude.ai does not hand a server's `instructions` to the
  model, so what the model must know is in the tools.
- The SDK answers a request handler that throws with the error's own
  message, and calls no `onerror` for it. Both handlers in
  `src/assistant/mcp.ts` therefore catch for themselves: log, and answer no
  more than `/api` would ("Something went wrong on the server."). Keep
  every new handler that way; a test renames a table and reads what Claude
  is told.
- `/mcp` alone also takes requests whose `Origin` is Claude's own site
  (`ASSISTANT_ORIGINS` in `mcp.ts`, given to `sameOrigin` as
  `allowOrigins`): Claude's servers name it in some requests and send none
  in others. `/api` takes it from no one; a test holds both.
- A tool's input schema is written by zod from the object the tool takes
  (`{ space, input }`), not from the route's input by itself, so that the
  definitions (`$defs`) and a type that holds itself land at the tool's
  root, where a client looks for them. The test reads each tool's schema
  with the SDK's own validator (`@modelcontextprotocol/server/validators/ajv`).
- The assistant's end-to-end test (`e2e/assistant.spec.ts`) runs in the
  Playwright project `assistant`, which depends on `server`, so that it
  starts only once `real-server.spec.ts` is done: those tests count on
  what the owner sees, and this one adds an app to a group of the owner's.
  It works in a group made for the run, which it leaves Off, without its
  app and without Lin (`leaveBehind`): an app or a member left there stays
  in the owner's and Lin's sessions, and the real-server tests of the next
  run on servers that were kept count the owner's apps. Never use the
  owner's personal space there (the move test counts on it).
  Its MCP client keeps a tool list for the minute Hearth allows (`ttlMs`),
  so it lists tools with `cacheMode: "refresh"` after each change. The card
  shows a level or a box as chosen before the server has saved it, so a
  step that then asks the server waits with `expect.poll` on what Claude's
  list or a call says, never on the card.
- The web app loads the session once. The Assistant card reads it again
  when it comes on screen and when the window is looked at again
  (`useSessionReadAgain`, not within 5 seconds of the last reading), since
  a space's level may have been changed by another owner or on another
  device, and a card that shows an old level turns an owner's next press
  into its opposite. Because the session is now read while a page is open,
  `adopt` in `session/preferences.tsx` lets the note of an unsaved theme or
  language win also while its save is on its way, and a save that went
  through reads the session anew: an answer from before the save must not
  put the old choice back. Do not reload the session after a save that
  failed: `adopt` sends an unsaved choice again whenever a session arrives,
  and the two would go round.
- In development the web app comes from Vite's dev server, which hands the
  server's own addresses on: `/api`, and `/mcp` as an exact match
  (`"^/mcp$"` in `packages/web/vite.config.ts`; a plain `"/mcp"` would hand
  on every path that begins like it). `packages/web/tests/dev-proxy.test.ts`
  holds it, so that the address the Assistant card shows works there too.
