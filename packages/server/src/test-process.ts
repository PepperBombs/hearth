/**
 * A server process as main.ts starts one, for serve.test.ts: serveHearth,
 * with a made-up app in place of the build's list. Not part of the running
 * server.
 *
 * The app's job asks for a feed, makes a promise of the answer that nothing
 * waits for, and fails at once. Once its run is over the request is called
 * off, and that promise rejects with nobody to hear it, which would end a
 * process that did not log such a rejection instead.
 */
import { defineApp } from "@hearth/sdk";
import { defineServer, z } from "@hearth/sdk/server";
import { serveHearth } from "./serve";

const manifest = defineApp({
  id: "leaver",
  name: { en: "Leaver", zh: "遗留" },
  description: { en: "Leaves a request behind.", zh: "留下一个请求。" },
  icon: "file-text",
  color: "teal",
  widget: { size: "small" },
  network: ["feeds.example.com"],
});
const leaver = defineServer(manifest, { items: z.object({ text: z.string() }) });

serveHearth([
  {
    id: "leaver",
    manifest,
    hasPage: false,
    server: leaver.routes({
      refresh: leaver.job({ description: "Asks for the week's feed and fails at once, every hour.", everyMinutes: 60 }, (ctx) => {
        void ctx.fetch("https://feeds.example.com/week.json").then((answer) => answer.text);
        throw new Error("The day's feed is down.");
      }),
    }),
  },
]);
