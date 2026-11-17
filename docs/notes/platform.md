# Notes: apps made in Hearth, the sandbox and the chat

`packages/server/src/made`, `packages/server/src/model`, `packages/web/src/made`, `packages/web/src/pages/chat.tsx`. The design is `docs/platform.md`.

Notes for whoever changes this part, people and agents alike. They are read when needed, not at the start of every session: add what you learn as one line, and correct a note in the change that makes it untrue.

- The frame's sandbox needs `allow-forms` (attribute and CSP alike): without it a browser never fires a form's submit event, so every form of a page is dead. `form-action 'none'` is what keeps a form from being sent.
- A frame reports the body's height, with its margins: the document's `scrollHeight` is never less than the iframe's own height, so a frame sized by it only ever grows.
- Newer Chromium returns a promise from `scrollIntoView()`: an effect written as `useEffect(() => el.scrollIntoView())` returns it, and React later calls it as the cleanup and throws. Write effects with a block body.
- Version 1 of `@anthropic-ai/sdk` sends the key as `Authorization: Bearer`, not `x-api-key`; a stand-in that checks the header must look there.
- `made_apps` refers to its install with a deferred foreign key, so that `createMadeApp` writes the app first and lets `addApp` (which asks the registry) find it in the same transaction.
- A dev server without `HEARTH_SECRET` makes one up per process: after a restart every saved key is unreadable and the chat answers `no_key` until it is entered again.
- The chat's history is plain text only, cut to 40 kB in the browser: `/api/*` takes bodies of up to 64 kB.
- A change to a made app is checked against every stored row (`rowsNotFitting` in `store.ts`), going back to a version too: a strict schema refuses a row with a field the app no longer has, so removing a field that holds data is refused rather than hiding the data.
- A built-in app's rows must fit its manifest exactly, as the build's app stored them (`packages/server/catalog/*/manifest.json`): change a field there and the move of the build's installs refuses every one that holds such a row.
- A made field that is `required` only has to be there: an empty text passes. A page that needs text checks it itself.
- `hearth.fetch` shares the jobs' pace (one request to a host every 6.5 s): a page that makes several waits for each in turn, and shows its progress.
- A page can be tried without a server: render it with `frameDocument` in an iframe whose parent answers the bridge from memory, checking rows with `collectionSchemas`. The built-in pages were checked that way.
