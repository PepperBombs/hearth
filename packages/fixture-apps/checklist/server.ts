import { defineServer, z } from "@hearth/sdk/server";
import manifest from "./manifest";

const app = defineServer(manifest, {
  items: z.object({
    name: z.string().trim().min(1).max(80),
    section: z.string().max(40).default(""),
    done: z.boolean().default(false),
  }),
});

export default app.routes({
  list: app.query(
    { description: "Lists every item on the checklist, oldest first, ticked or not." },
    (ctx) => ctx.db.items.list({ orderBy: "createdAt" }),
  ),
  add: app.mutation(
    {
      description: "Adds an item to the checklist, optionally under one of its sections.",
      input: z.object({ name: z.string(), section: z.string().default("") }),
    },
    (ctx, input) => ctx.db.items.insert({ ...input, done: false }),
  ),
  tick: app.mutation(
    {
      description: "Ticks one item of the checklist off, or unticks it.",
      input: z.object({ id: z.string(), done: z.boolean() }),
    },
    (ctx, { id, done }) => ctx.db.items.update(id, { done }),
  ),
  clearTicked: app.mutation(
    { description: "Deletes every ticked item from the checklist and says how many went." },
    (ctx) => ctx.db.items.removeWhere({ done: true }),
  ),
});
