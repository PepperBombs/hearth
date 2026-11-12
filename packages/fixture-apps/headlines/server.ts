import { defineServer, z } from "@hearth/sdk/server";
import manifest from "./manifest";

/** The sample feed the job reads. Its host is the one the manifest lists in `network`: a job may fetch from no other. */
const FEED = "https://feeds.example.com/headlines.json";
/** How many headlines are kept: the feed's first ones, in its order. */
const KEPT = 5;
/** The longest title kept, in characters. A longer one is cut. */
const LONGEST = 200;

const app = defineServer(manifest, {
  headlines: z.object({ title: z.string().min(1).max(LONGEST) }),
});

/** What the job reads of the feed's answer. An answer of another shape fails the run, and the headlines kept stay. */
const feedAnswer = z.object({ items: z.array(z.object({ title: z.string() })) });

/** A title as it is kept: on one line, and at most LONGEST characters, never half of one. */
function asKept(title: string): string {
  const line = title.replace(/\s+/g, " ").trim();
  if (line.length <= LONGEST) return line;
  // One place for "…"; a character beyond the basic plane is two places, and is not cut in half.
  const cut = line.slice(0, LONGEST - 1).replace(/[\uD800-\uDBFF]$/, "");
  return `${cut}…`;
}

export default app.routes({
  latest: app.query(
    { description: "Lists the headlines the last refresh kept, in the feed's order." },
    // One write stores them all at one moment, and rows that tie come in the order they were inserted.
    (ctx) => ctx.db.headlines.list(),
  ),
  refresh: app.job(
    {
      description: "Fetches the sample news feed and keeps its first five headlines in place of those kept before.",
      everyMinutes: 60,
    },
    async (ctx) => {
      const answer = await ctx.fetch(FEED, { headers: { accept: "application/json" } });
      if (!answer.ok) throw new Error(`The feed answered ${answer.status}.`);
      const read = feedAnswer.safeParse(answer.json());
      if (!read.success) throw new Error("The feed's answer is not a list of headlines.");
      const titles = read.data.items
        .map((item) => asKept(item.title))
        .filter((title) => title !== "")
        .slice(0, KEPT);
      // Fetched first, then written in one go: no transaction waits on the network, and a run that
      // fails before this line leaves the headlines of the last run that went well.
      ctx.write((db) => {
        db.headlines.removeWhere({});
        for (const title of titles) db.headlines.insert({ title });
      });
    },
  ),
});
