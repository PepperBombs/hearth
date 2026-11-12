# Headlines

A sample mini-app that belongs to the framework: the latest headlines of a
sample news feed, which a job fetches every hour. It is the framework's
app with a job, so its tests, and the end-to-end tests that build it in,
follow a job from the feed to the dashboard: the first run as soon as the
app is added to a space, "Updated N min ago", "Refresh now", and what the
card says when the feed cannot be reached.

| File | Holds |
|---|---|
| `manifest.ts` | Name, icon, card size, `network: ["feeds.example.com"]` (the one host its job may fetch from, which the dialog that adds the app names) and the interface strings, each in English and Chinese. It has no settings. |
| `server.ts` | One collection, `headlines` (`title`), the query `latest` and the job `refresh`, which runs every 60 minutes: it fetches `https://feeds.example.com/headlines.json` with `ctx.fetch`, then puts the feed's first five titles in place of those kept before, in one `ctx.write`. |
| `widget.tsx` | The body of the dashboard card: the headlines, "Updated N min ago" (the time of day after 90 minutes), "Refreshing…" while a run is going on or was asked for, the failed state ("Couldn't reach the feed at 14:05. Showing headlines from 13:05."), and "Refresh now" for someone who may edit. |
| `headlines.test.ts` | Its tests, written with `testApp` from `@hearth/sdk/testing` and run with `hearth-apps test`: runs of the job with stand-ins for the feed (what it asks for, what it keeps, a feed that fails or answers something else), the job's status as a viewer sees it, and a run asked for with view and with edit. |
| `package.json` | The app's name. A mini-app declares no dependencies. |

## The feed

The job asks for JSON and reads a list of titles, in the order the feed
gives them:

```json
{ "items": [{ "title": "Rain expected in the hills tonight" }, { "title": "The library opens a new reading room" }] }
```

It keeps the first five, each on one line and cut to 200 characters; an
empty title is passed over. A run fails, and the headlines of the last run
that went well stay, when the feed cannot be reached, answers with a status
that is not 2xx, or answers with anything but such a list. Then the card
says when the run failed and which headlines it shows, and the scheduler
tries again 5, 10, 20 and 40 minutes later, then every hour.

`feeds.example.com` serves no feed, so wherever the job reaches the real
host, every run fails: on a server, and under `pnpm dev`, which runs jobs
against the hosts their manifests name. The end-to-end tests answer for it
from a file of stand-in answers, and the app's own tests with a function.
To see it work under `pnpm dev`, write such a file and name it in
`HEARTH_FETCH_STANDINS` (by an absolute path; dev mode only):

```sh
echo '[{ "url": "https://feeds.example.com/headlines.json", "body": { "items": [{ "title": "Rain expected" }] } }]' > /tmp/headlines.json
HEARTH_APPS_DIR=packages/fixture-apps HEARTH_AUTH=dev HEARTH_OWNER_EMAIL=you@example.com \
  HEARTH_FETCH_STANDINS=/tmp/headlines.json pnpm dev
```

Everything in it is sample data.
