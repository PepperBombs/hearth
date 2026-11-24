/**
 * A stand-in for every person's model, for the end-to-end tests against the
 * real server: started by playwright.config.ts on MODEL_PORT (e2e/servers.ts),
 * and asked by every copy of the server in place of the model a person
 * chose (HEARTH_MODEL_STANDIN). It speaks the part of OpenAI's chat
 * completions that packages/server/src/model/providers.ts uses: a POST to
 * /chat/completions, answered with one message. Anything else is 404. It
 * reaches no other host.
 *
 * To most messages it answers "Noted: " and the last message of the
 * person's, as the server sent it: with the notes Hearth adds to it (the
 * person's answers to requests to delete, "[Hearth: ...]"), so that a test
 * can see what the model was told. It calls no tool then.
 *
 * To a message whose own words are "delete " and a text, it asks to delete
 * the row that holds that text, as a model would, in three steps of one
 * turn: it reads the rows of every app the system prompt lists (list_rows),
 * asks to delete the first row one of whose fields is that text, ignoring
 * case (delete_rows), and then says "Asked before deleting " and the text.
 * When no row holds it, it says "Found nothing called " and the text; when
 * a tool is refused, "Could not ask: " and why.
 *
 * To "make " and a name, it makes an app of that name (create_app): a
 * ledger whose page lists its entries (`LEDGER`), and says "Made " and the
 * name, or "Could not make: " and why.
 *
 * To "Change “<name>”: call it <new name>", as the chat link of a copy
 * fills the box and the person finishes it (docs/center.md), it reads the
 * app of that name the system prompt lists (read_app), renames it
 * (update_app, with the rest of its manifest and its page as they were),
 * and says "Renamed <name> to <new name>", or "Could not rename: " and why.
 *
 * Run with Node, which strips the types: `node e2e/model-stand-in.ts <port>`.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node e2e/model-stand-in.ts <port>");
  process.exit(2);
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
type Reply = { role: "assistant"; content: string; tool_calls?: ToolCall[] };

/** Where rows are: an app and one of its collections, as the system prompt lists them. */
type Place = { appId: string; collection: string };

const LIST_CALL = "stand-in-list-";
const DELETE_CALL = "stand-in-delete";
const MAKE_CALL = "stand-in-make";
const READ_CALL = "stand-in-read";
const RENAME_CALL = "stand-in-rename";

/**
 * The app "make " makes, under the name asked for: one collection of
 * entries, instructions for whoever changes it, and a page that lists the
 * entries, oldest first, and draws them again when they change.
 */
const LEDGER = {
  description: "What we spend, one entry at a time.",
  icon: "wallet",
  color: "green",
  size: "wide",
  collections: { entries: { fields: { item: { type: "text", required: true }, amount: { type: "number" } } } },
  instructions: "Amounts are in euros.",
};
const LEDGER_PAGE = `<!doctype html>
<html><body>
<p id="empty">No entries yet.</p>
<ul id="entries" aria-label="Entries"></ul>
<script>
async function draw() {
  const rows = await hearth.list("entries");
  document.getElementById("empty").hidden = rows.length > 0;
  document.getElementById("entries").replaceChildren(...rows.map((row) => {
    const item = document.createElement("li");
    item.textContent = row.amount === undefined ? row.item : row.item + ": " + row.amount;
    return item;
  }));
}
hearth.onChange(draw);
draw();
</script>
</body></html>`;

/** The text of the last message of the person's, as the server sent it. */
function lastUserText(messages: readonly Message[]): string {
  const last = messages.findLast((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

/**
 * The person's own words: what is left of their message once Hearth's notes
 * before it, joined to it with a blank line, are taken away.
 */
function ownWords(text: string): string {
  return text
    .split("\n\n")
    .filter((part) => !part.startsWith("[Hearth: "))
    .join("\n\n")
    .trim();
}

/** What the person asked to delete, or null for any other message. */
function deleteTarget(text: string): string | null {
  const match = /^delete (.+)$/i.exec(ownWords(text));
  return match?.[1]?.trim() || null;
}

/** The name of the app the person asked to make, or null for any other message. */
function makeTarget(text: string): string | null {
  const match = /^make (.+)$/i.exec(ownWords(text));
  return match?.[1]?.trim() || null;
}

/** The app the person asked to rename, and its new name, or null for any other message. */
function renameTarget(text: string): { from: string; to: string } | null {
  const match = /^Change “(.+?)”: call it (.+)$/.exec(ownWords(text));
  return match ? { from: match[1]!.trim(), to: match[2]!.trim() } : null;
}

/** The ID of the app the system prompt lists under a name, in one language or two ("- appId <id>, version <n>: <name>..."). */
function appNamed(messages: readonly Message[], name: string): string | null {
  const system = messages.find((message) => message.role === "system");
  for (const line of (typeof system?.content === "string" ? system.content : "").split("\n")) {
    const app = /^- appId (\S+), version \d+: (.*)$/.exec(line);
    if (app && (app[2]!.startsWith(JSON.stringify(name)) || app[2]!.startsWith(`{"en":${JSON.stringify(name)}`))) return app[1]!;
  }
  return null;
}

/** Every collection of every app the system prompt lists: "- appId <id>, version ..." and its "    - <collection> { ... }" lines. */
function placesIn(messages: readonly Message[]): Place[] {
  const system = messages.find((message) => message.role === "system");
  const places: Place[] = [];
  let appId: string | null = null;
  for (const line of (typeof system?.content === "string" ? system.content : "").split("\n")) {
    const app = /^- appId (\S+), version \d+:/.exec(line);
    if (app) {
      appId = app[1] ?? null;
      continue;
    }
    const collection = /^ {4}- (\S+) \{/.exec(line);
    if (collection && appId !== null) places.push({ appId, collection: collection[1] ?? "" });
    else if (!line.startsWith(" ")) appId = null;
  }
  return places;
}

const say = (content: string): Reply => ({ role: "assistant", content });

function call(id: string, name: string, input: unknown): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(input) } };
}

/** The answers to the tool calls of this turn's last step, by call ID. */
function toolResults(messages: readonly Message[]): Map<string, string> {
  const results = new Map<string, string>();
  for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "tool"; index -= 1) {
    const message = messages[index]!;
    if (typeof message.tool_call_id === "string") results.set(message.tool_call_id, typeof message.content === "string" ? message.content : "");
  }
  return results;
}

/** The calls of this turn's last step, which `toolResults` answer. */
function lastCalls(messages: readonly Message[]): ToolCall[] {
  const asked = messages.findLast((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
  return (asked?.tool_calls as ToolCall[] | undefined) ?? [];
}

/** The first row, in any place read, one of whose fields is `wanted`, ignoring case. */
function findRow(calls: readonly ToolCall[], results: Map<string, string>, wanted: string): (Place & { rowId: string }) | null {
  for (const asked of calls) {
    let rows: unknown;
    try {
      rows = (JSON.parse(results.get(asked.id) ?? "") as { rows?: unknown }).rows;
    } catch {
      continue;
    }
    if (!Array.isArray(rows)) continue;
    const place = JSON.parse(asked.function.arguments) as Place;
    for (const row of rows as Record<string, unknown>[]) {
      const holds = Object.entries(row).some(
        ([field, value]) => !["id", "createdAt", "updatedAt", "createdBy", "updatedBy"].includes(field) && typeof value === "string" && value.trim().toLowerCase() === wanted.toLowerCase(),
      );
      if (holds && typeof row.id === "string") return { appId: place.appId, collection: place.collection, rowId: row.id };
    }
  }
  return null;
}

/** Makes an app of the name asked for, in two steps of one turn. */
function make(messages: readonly Message[], name: string): Reply {
  if (messages.at(-1)?.role === "user") {
    return { role: "assistant", content: "", tool_calls: [call(MAKE_CALL, "create_app", { manifest: { name, ...LEDGER }, html: LEDGER_PAGE })] };
  }
  const answer = toolResults(messages).get(MAKE_CALL) ?? "";
  return say(answer.includes('"appId"') ? `Made ${name}` : `Could not make: ${answer}`);
}

/** Renames the app of a name, in three steps of one turn: read it, change it, say so. */
function rename(messages: readonly Message[], { from, to }: { from: string; to: string }): Reply {
  if (messages.at(-1)?.role === "user") {
    const appId = appNamed(messages, from);
    if (appId === null) return say(`Could not rename: no app is called ${from}`);
    return { role: "assistant", content: "", tool_calls: [call(READ_CALL, "read_app", { appId })] };
  }
  const results = toolResults(messages);
  const read = results.get(READ_CALL);
  if (read !== undefined) {
    let app: { appId?: unknown; manifest?: Record<string, unknown> };
    try {
      app = JSON.parse(read) as typeof app;
    } catch {
      return say(`Could not rename: ${read}`);
    }
    if (typeof app.appId !== "string" || !app.manifest) return say(`Could not rename: ${read}`);
    return {
      role: "assistant",
      content: "",
      tool_calls: [call(RENAME_CALL, "update_app", { appId: app.appId, manifest: { ...app.manifest, name: to }, note: `Renamed to ${to}` })],
    };
  }
  const answer = results.get(RENAME_CALL) ?? "";
  return say(answer.includes('"version"') ? `Renamed ${from} to ${to}` : `Could not rename: ${answer}`);
}

/** The stand-in's next message in the conversation the server sent. */
function reply(messages: readonly Message[]): Reply {
  const text = lastUserText(messages);
  const making = makeTarget(text);
  if (making !== null) return make(messages, making);
  const renaming = renameTarget(text);
  if (renaming !== null) return rename(messages, renaming);
  const wanted = deleteTarget(text);
  const last = messages.at(-1);
  if (wanted === null) return say(`Noted: ${text}`);

  // The person's message: read every collection of every app here.
  if (last?.role === "user") {
    const places = placesIn(messages);
    if (places.length === 0) return say(`Found nothing called ${wanted}`);
    return { role: "assistant", content: "", tool_calls: places.map((place, index) => call(`${LIST_CALL}${index}`, "list_rows", place)) };
  }

  const calls = lastCalls(messages);
  const results = toolResults(messages);
  // The rows were read: ask to delete the one that holds the text.
  if (calls.every((asked) => asked.id.startsWith(LIST_CALL))) {
    const found = findRow(calls, results, wanted);
    if (!found) return say(`Found nothing called ${wanted}`);
    return { role: "assistant", content: "", tool_calls: [call(DELETE_CALL, "delete_rows", { appId: found.appId, collection: found.collection, rowIds: [found.rowId] })] };
  }
  // The person was asked, or the server refused to ask them.
  const answer = results.get(DELETE_CALL) ?? "";
  return say(answer.includes('"asked":true') ? `Asked before deleting ${wanted}` : `Could not ask: ${answer}`);
}

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://stand-in").pathname;
  if (request.method !== "POST" || path !== "/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "The stand-in model answers POST /chat/completions alone." } }));
    return;
  }
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    let messages: Message[];
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: unknown } | null;
      messages = Array.isArray(body?.messages) ? (body.messages as Message[]) : [];
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The body is not JSON." } }));
      return;
    }
    const message = reply(messages);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] }));
  });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
