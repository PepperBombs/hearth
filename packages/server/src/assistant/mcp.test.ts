/**
 * The assistant's MCP endpoint (docs/mini-app-contract.md, section F, "The
 * endpoint", "The tools", "Calling a tool", build step F2), driven by the
 * official MCP client over the application's own fetch, with no socket and
 * no network, in both protocol eras: the 2025 handshake Claude speaks today
 * and 2026-07-28.
 */
import { defineApp } from "@hearth/sdk";
import { AppError, defineServer, z } from "@hearth/sdk/server";
import { appCallResponseSchema } from "@hearth/shared";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppFaultError } from "../apps/calls";
import { createRegistry, type BundledApp } from "../apps/registry";
import { APPS, family, grant, install, KIM, LIN, NOA, SAM, setPrefs } from "../apps/test-world";
import { as, testApp } from "../testing";
import { CALLS_PER_MINUTE, INSTRUCTIONS, MAX_ANSWER_CHARACTERS } from "./mcp";
import { createToolCatalog, SPACES_TOOL, TOOL_NAME_LIMIT } from "./tools";

const BASE = "http://hearth.example.com";

/* -------------------------------------------------------------------------
 * A made-up app for what the sample checklist has no reason to do: refuse,
 * fail, answer at length, and carry a route whose tool name is too long.
 * ---------------------------------------------------------------------- */
const labManifest = defineApp({
  id: "lab",
  name: { en: "Lab", zh: "实验室" },
  description: { en: "Tries what an assistant meets.", zh: "试试助手会遇到的情况。" },
  icon: "box",
  color: "blue",
  widget: { size: "small" },
});
const lab = defineServer(labManifest, { notes: z.object({ text: z.string().max(40) }) });
const LONG_ROUTE = `r${"o".repeat(TOOL_NAME_LIMIT)}`;
const labServer = lab.routes({
  echo: lab.query(
    { description: "Answers with the text it is given, as many times as asked.", input: z.object({ text: z.string().min(1), times: z.number().int().min(1).max(3).default(1) }) },
    (_ctx, { text, times }) => Array.from({ length: times }, () => text),
  ),
  note: lab.mutation({ description: "Keeps a short note.", input: z.object({ text: z.string() }) }, (ctx, { text }) =>
    ctx.db.notes.insert({ text }),
  ),
  notes: lab.query({ description: "Lists the notes, oldest first." }, (ctx) => ctx.db.notes.list()),
  refuse: lab.mutation({ description: "Keeps a note and then turns the request down." }, (ctx) => {
    ctx.db.notes.insert({ text: "should not stay" });
    throw new AppError("conflict", "No room for that.");
  }),
  crash: lab.query({ description: "Fails with an error of its own." }, () => {
    throw new Error("boom: a secret from inside the app");
  }),
  big: lab.query({ description: "Answers with a very long text." }, () => "x".repeat(MAX_ANSWER_CHARACTERS)),
  quiet: lab.mutation({ description: "Keeps a note and answers with nothing." }, (ctx) => {
    ctx.db.notes.insert({ text: "quiet" });
  }),
  [LONG_ROUTE]: lab.query({ description: "Has a name too long for a tool." }, () => "unreachable"),
});
const LAB: BundledApp = { id: "lab", manifest: labManifest, hasPage: false, server: labServer };
const ALL_APPS = [...APPS, LAB];

let world: ReturnType<typeof family>;
let server: ReturnType<typeof testApp>;
const clients: Client[] = [];
/** The protocol version each request the clients sent named, in order. */
let versionsSent: (string | null)[] = [];

beforeEach(() => {
  world = family();
  server = testApp({ db: world.db, apps: ALL_APPS });
  versionsSent = [];
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const setLevel = (spaceId: string, level: "none" | "view" | "edit") =>
  world.db.prepare("UPDATE spaces SET assistant = ? WHERE id = ?").run(level, spaceId);
const leaveOut = (spaceId: string, appId: string) =>
  world.db.prepare("UPDATE space_apps SET assistant = 0 WHERE space_id = ? AND app_id = ?").run(spaceId, appId);
const notesIn = (spaceId: string) =>
  (world.db.prepare("SELECT count(*) AS n FROM app_rows WHERE space_id = ? AND app_id = 'lab'").get(spaceId) as { n: number }).n;

type Era = "legacy" | "modern";

/** An MCP client signed in as `who`, talking to the application directly. */
async function connect(who: string, era: Era = "legacy"): Promise<Client> {
  const client = new Client(
    { name: "hearth-test", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      request.headers.set("x-test-identity", who);
      versionsSent.push(request.headers.get("mcp-protocol-version"));
      return server.app.fetch(request);
    },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((tool) => tool.name);
}

/** What a call answered, as text, and whether it was a failure. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return { text: content[0]!.text, failed: result.isError === true };
}

/** A raw POST to the endpoint, for what the client would never send. */
function post(body: unknown, headers: Record<string, string> = {}) {
  return server.app.request(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

describe.each<Era>(["legacy", "modern"])("over MCP (%s)", (era) => {
  describe("the tools", () => {
    beforeEach(() => {
      install(world.db, world.samsSpace, "checklist", world.sam.id);
      install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "view" });
      install(world.db, world.family, "lab", world.sam.id, { memberAccess: "view" });
      install(world.db, world.family, "feed", world.sam.id, { memberAccess: "edit" });
    });

    it("names Hearth, and tells the assistant what Hearth is", async () => {
      const client = await connect(SAM, era);
      expect(client.getServerVersion()).toMatchObject({ name: "hearth", version: "test" });
      expect(client.getInstructions()).toBe(INSTRUCTIONS);
      await client.listTools();
      // The era asked for is the one spoken: the 2025 handshake starts without a version.
      expect(versionsSent.at(-1)).toBe(era === "modern" ? "2026-07-28" : "2025-11-25");
      expect(versionsSent.every((version) => (era === "modern" ? version === "2026-07-28" : version !== "2026-07-28"))).toBe(true);
    });

    it("gives someone whose spaces are all Off only Hearth's own tool", async () => {
      expect(await toolNames(await connect(SAM, era))).toEqual([SPACES_TOOL]);
      expect(await toolNames(await connect(NOA, era))).toEqual([SPACES_TOOL]);
    });

    it("gives an owner every query and mutation where the assistant may change things, apps by ID", async () => {
      setLevel(world.samsSpace, "edit");
      setLevel(world.family, "edit");
      const tools = (await (await connect(SAM, era)).listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual([
        SPACES_TOOL,
        "checklist_list",
        "checklist_add",
        "checklist_tick",
        "checklist_clearTicked",
        "lab_echo",
        "lab_note",
        "lab_notes",
        "lab_refuse",
        "lab_crash",
        "lab_big",
        "lab_quiet",
      ]);
      const add = tools.find((tool) => tool.name === "checklist_add")!;
      expect(add.title).toBe("Checklist: add");
      expect(add.description).toMatch(/^Adds .*It belongs to the app "Checklist": /);
      expect(add.annotations).toEqual({
        title: "Checklist: add",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(add.inputSchema).toMatchObject({
        type: "object",
        properties: { space: { type: "string", enum: ["Personal", "Family"] }, input: { type: "object" } },
        required: ["space", "input"],
        additionalProperties: false,
      });
      const list = tools.find((tool) => tool.name === "checklist_list")!;
      expect(list.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(list.inputSchema).toEqual({
        type: "object",
        properties: { space: expect.objectContaining({ enum: ["Personal", "Family"] }) },
        required: ["space"],
        additionalProperties: false,
      });
      // The route's own schema, as it is given: a field with a default may be left out.
      const echo = tools.find((tool) => tool.name === "lab_echo")!;
      expect(echo.inputSchema.properties?.input).toMatchObject({
        type: "object",
        properties: { text: { type: "string", minLength: 1 }, times: { type: "integer", default: 1 } },
        required: ["text"],
      });
      expect(echo.inputSchema.properties?.input).not.toHaveProperty("$schema");
    });

    it("gives a member who may only view the queries alone, and only where they may use the app", async () => {
      setLevel(world.family, "edit");
      expect(await toolNames(await connect(LIN, era))).toEqual([
        SPACES_TOOL,
        "checklist_list",
        "lab_echo",
        "lab_notes",
        "lab_crash",
        "lab_big",
      ]);
      grant(world.db, world.family, "lab", world.kim.id, "edit", world.sam.id);
      const kims = await toolNames(await connect(KIM, era));
      expect(kims).toContain("lab_note");
      expect(kims).not.toContain("checklist_add");
    });

    it("offers queries alone while the space is Read only, even to its owner", async () => {
      setLevel(world.family, "view");
      const tools = await toolNames(await connect(SAM, era));
      expect(tools).toContain("checklist_list");
      expect(tools.filter((name) => ["checklist_add", "lab_note", "lab_quiet"].includes(name))).toEqual([]);
    });

    it("leaves out an app the person switched off, the owners left out, removed, or the build lacks", async () => {
      setLevel(world.family, "edit");
      setPrefs(world.db, world.family, "lab", world.lin.id, { enabled: false, pinned: false });
      expect((await toolNames(await connect(LIN, era))).filter((name) => name.startsWith("lab_"))).toEqual([]);
      expect((await toolNames(await connect(SAM, era))).filter((name) => name.startsWith("lab_"))).not.toEqual([]);
      leaveOut(world.family, "lab");
      expect((await toolNames(await connect(SAM, era))).filter((name) => name.startsWith("lab_"))).toEqual([]);
      world.db.prepare("UPDATE space_apps SET removed_at = '2026-01-09T00:00:00.000Z' WHERE space_id = 'family' AND app_id = 'checklist'").run();
      install(world.db, world.family, "retired", world.sam.id, { memberAccess: "edit" });
      const left = await toolNames(await connect(SAM, era));
      expect(left.filter((name) => name.startsWith("checklist_") || name.startsWith("retired"))).toEqual([]);
    });

    it("names spaces as people see them, and tells apart two with one name", async () => {
      world.db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('club', 'group', 'Family', ?, '2026-01-07T00:00:00.000Z')").run(world.sam.id);
      world.db.prepare("INSERT INTO spaces (id, kind, name, created_by, created_at) VALUES ('mine', 'group', 'Personal', ?, '2026-01-08T00:00:00.000Z')").run(world.sam.id);
      for (const space of ["club", "mine"]) {
        world.db.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'owner', '2026-01-07T00:00:00.000Z')").run(space, world.sam.id);
        install(world.db, space, "checklist", world.sam.id);
        setLevel(space, "edit");
      }
      setLevel(world.samsSpace, "edit");
      setLevel(world.family, "edit");
      const add = (await (await connect(SAM, era)).listTools()).tools.find((tool) => tool.name === "checklist_add")!;
      expect(add.inputSchema.properties?.space).toMatchObject({ enum: ["Personal", "Family", "Family (2)", "Personal (2)"] });
    });
  });

  describe("calling a tool", () => {
    beforeEach(() => {
      install(world.db, world.family, "checklist", world.sam.id, { memberAccess: "edit" });
      install(world.db, world.family, "lab", world.sam.id, { memberAccess: "edit" });
      setLevel(world.family, "edit");
    });

    it("changes data as the person, which the web app then reads", async () => {
      const client = await connect(LIN, era);
      const added = await call(client, "checklist_add", { space: "Family", input: { name: "Milk" } });
      expect(added.failed).toBe(false);
      expect(JSON.parse(added.text)).toMatchObject({ name: "Milk", done: false, createdBy: world.lin.id });
      const response = await server.app.request(`${BASE}/api/spaces/${world.family}/apps/checklist/q/list`, {
        method: "POST",
        headers: as(SAM, { "content-type": "application/json" }),
        body: "{}",
      });
      expect(appCallResponseSchema.parse(await response.json()).output).toEqual([expect.objectContaining({ name: "Milk" })]);
      expect(await call(client, "lab_quiet", { space: "Family" })).toEqual({ text: "Done.", failed: false });
    });

    it("refuses a space the tool is not offered in, naming those it is", async () => {
      install(world.db, world.samsSpace, "lab", world.sam.id);
      const client = await connect(SAM, era);
      for (const space of ["Personal", "Somewhere", 3]) {
        expect(await call(client, "lab_note", { space, input: { text: "x" } })).toEqual({
          text: '"space" must be one of "Family": the spaces where lab_note is offered to this person.',
          failed: true,
        });
      }
      expect(await call(client, "lab_note", { input: { text: "x" } })).toMatchObject({ failed: true });
      expect(notesIn(world.family)).toBe(0);
    });

    it("refuses input that does not fit, saying where, and arguments it does not take", async () => {
      const client = await connect(SAM, era);
      expect(await call(client, "lab_note", { space: "Family", input: { text: 3 } })).toEqual({
        text: expect.stringMatching(/^input\.text: /),
        failed: true,
      });
      expect(await call(client, "lab_note", { space: "Family" })).toEqual({ text: expect.stringMatching(/^input: /), failed: true });
      expect(await call(client, "lab_quiet", { space: "Family", input: {} })).toEqual({
        text: 'lab_quiet takes "space", not "input".',
        failed: true,
      });
      expect(await call(client, "lab_note", { space: "Family", input: { text: "x" }, spaceId: "family" })).toEqual({
        text: 'lab_note takes "space", "input", not "spaceId".',
        failed: true,
      });
      expect(notesIn(world.family)).toBe(0);
    });

    it("passes on an app's refusal, keeping nothing it wrote", async () => {
      const client = await connect(SAM, era);
      expect(await call(client, "lab_refuse", { space: "Family" })).toEqual({ text: "No room for that.", failed: true });
      expect(notesIn(world.family)).toBe(0);
      expect(server.errors).toEqual([]);
    });

    it("logs an app that fails, and tells the assistant nothing of what it said", async () => {
      const client = await connect(SAM, era);
      expect(await call(client, "lab_crash", { space: "Family" })).toEqual({
        text: 'The app "Lab" failed while answering, and nothing was changed.',
        failed: true,
      });
      expect(server.errors).toEqual([expect.any(AppFaultError)]);
    });

    it("does not send an answer that is too long", async () => {
      const result = await call(await connect(SAM, era), "lab_big", { space: "Family" });
      expect(result).toEqual({
        text: expect.stringContaining(`more than the ${MAX_ANSWER_CHARACTERS} Hearth sends`),
        failed: true,
      });
      const echoed = await call(await connect(SAM, era), "lab_echo", { space: "Family", input: { text: "hi", times: 2 } });
      expect(echoed).toEqual({ text: '["hi","hi"]', failed: false });
    });

    it("answers an unknown tool with a protocol error, and one not offered now with a reason", async () => {
      const client = await connect(LIN, era);
      await expect(client.callTool({ name: "nothing_here", arguments: {} })).rejects.toMatchObject({ code: -32602 });
      setLevel(world.family, "view");
      expect(await call(client, "lab_note", { space: "Family", input: { text: "x" } })).toEqual({
        text: expect.stringMatching(new RegExp(`^Hearth offers lab_note to this person in no space now\\. ${SPACES_TOOL} says what the assistant may use\\. Claude keeps a connector's list of tools for a while`)),
        failed: true,
      });
    });

    it("tells, through hearth-spaces, what the assistant may do in each space and why a space offers nothing", async () => {
      const report = JSON.parse((await call(await connect(LIN, era), SPACES_TOOL)).text);
      expect(report).toEqual({
        you: "lin",
        spaces: [
          {
            space: "Personal",
            kind: "personal",
            yourRole: "owner",
            assistant: "Off",
            apps: [],
            note: "The assistant is off in this space. You are the one to switch it on, in Hearth's Settings.",
          },
          {
            space: "Family",
            kind: "group",
            yourRole: "member",
            assistant: "Read and change",
            apps: [
              {
                app: "Checklist",
                id: "checklist",
                assistantMay: "read and change",
                tools: ["checklist_list", "checklist_add", "checklist_tick", "checklist_clearTicked"],
              },
              {
                app: "Lab",
                id: "lab",
                assistantMay: "read and change",
                tools: ["lab_echo", "lab_note", "lab_notes", "lab_refuse", "lab_crash", "lab_big", "lab_quiet"],
              },
            ],
          },
        ],
      });
      expect(await call(await connect(LIN, era), SPACES_TOOL, { space: "Family" })).toEqual({
        text: `${SPACES_TOOL} takes no arguments.`,
        failed: true,
      });
    });
  });
});

describe("the limit on calls", () => {
  it(`takes ${CALLS_PER_MINUTE} calls a minute from each person, and says when to try again`, async () => {
    install(world.db, world.family, "lab", world.sam.id, { memberAccess: "edit" });
    setLevel(world.family, "edit");
    const sam = await connect(SAM);
    for (let i = 0; i < CALLS_PER_MINUTE; i += 1) {
      expect((await call(sam, "lab_echo", { space: "Family", input: { text: "hi" } })).failed).toBe(false);
    }
    expect(await call(sam, "lab_echo", { space: "Family", input: { text: "hi" } })).toEqual({
      text: expect.stringMatching(/^Too many calls: Hearth takes at most 60 a minute from each person\. Try again in \d+ seconds\.$/),
      failed: true,
    });
    // Someone else is not held back.
    expect((await call(await connect(LIN), "lab_echo", { space: "Family", input: { text: "hi" } })).failed).toBe(false);
  });
});

describe("the endpoint over HTTP", () => {
  it("answers GET and DELETE with 405, since it keeps no session to stream or to end", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await server.app.request(`${BASE}/mcp`, { method, headers: as(SAM, { accept: "text/event-stream" }) });
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(await response.json()).toEqual({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
    }
    // Only that address: the web app's own root takes no POST.
    expect((await server.app.request(`${BASE}/`, { method: "POST", headers: as(SAM, { "content-type": "application/json" }), body: JSON.stringify(INITIALIZE) })).status).toBe(404);
  });

  it("needs a sign-in and a member, as /api does", async () => {
    expect((await post(INITIALIZE)).status).toBe(401);
    const stranger = await post(INITIALIZE, as("stranger@example.com"));
    expect(stranger.status).toBe(403);
    expect((await post(INITIALIZE, as(SAM))).status).toBe(200);
  });

  it("refuses a page of another site", async () => {
    const pages: Record<string, string>[] = [
      { origin: "https://elsewhere.example" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "null" },
    ];
    for (const headers of pages) {
      const response = await post(INITIALIZE, as(SAM, headers));
      expect(response.status, JSON.stringify(headers)).toBe(403);
    }
    expect((await post(INITIALIZE, as(SAM, { origin: BASE, "sec-fetch-site": "same-origin" }))).status).toBe(200);
  });

  it("takes JSON alone, of at most 64 KiB, and is never stored by a cache", async () => {
    const plain = await post(JSON.stringify(INITIALIZE), as(SAM, { "content-type": "text/plain" }));
    expect(plain.status).toBe(415);
    const huge = await post({ ...INITIALIZE, padding: "x".repeat(65 * 1024) }, as(SAM));
    expect(huge.status).toBe(413);
    const fine = await post(INITIALIZE, as(SAM));
    expect(fine.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the catalog of tools", () => {
  it("leaves out a route whose tool name would be too long, and says so at start-up", () => {
    const catalog = createToolCatalog(createRegistry(ALL_APPS));
    expect(catalog.byName.has(`lab_${LONG_ROUTE}`)).toBe(false);
    expect(catalog.warnings).toEqual([expect.stringContaining(`the query "${LONG_ROUTE}" is not offered to assistants`)]);
    expect(server.warnings).toEqual(catalog.warnings);
    // Jobs are not tools.
    expect([...catalog.byName.keys()].filter((name) => name.startsWith("headlines_"))).toEqual(["headlines_latest"]);
  });
});
