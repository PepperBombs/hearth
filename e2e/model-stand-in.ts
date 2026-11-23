/**
 * A stand-in for every person's model, for the end-to-end tests against the
 * real server: started by playwright.config.ts on MODEL_PORT (e2e/servers.ts),
 * and asked by every copy of the server in place of the model a person
 * chose (HEARTH_MODEL_STANDIN). It speaks the part of OpenAI's chat
 * completions that packages/server/src/model/providers.ts uses: a POST to
 * /chat/completions, answered with one message that calls no tool,
 * "Noted: " and the last message of the person's. Anything else is 404. It
 * reaches no other host.
 *
 * Run with Node, which strips the types: `node e2e/model-stand-in.ts <port>`.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node e2e/model-stand-in.ts <port>");
  process.exit(2);
}

type Message = { role?: unknown; content?: unknown };

/** The text of the last message of the person's, as the server sent it. */
function lastUserText(body: unknown): string {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages)) return "";
  const last = (messages as Message[]).findLast((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : "";
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
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "The body is not JSON." } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Noted: ${lastUserText(body)}` } }],
      }),
    );
  });
});

server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close(() => process.exit(0)));
