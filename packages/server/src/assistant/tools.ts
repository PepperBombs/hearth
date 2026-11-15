/**
 * The tools an assistant gets (docs/mini-app-contract.md, section F, "The
 * tools"): every query and mutation of the apps in this build, as one
 * catalog made when the server starts, and each person's own list of them,
 * made at every request from what `VISIBLE` allows an assistant for them.
 *
 * Nothing here decides access: `listAssistantInstalls` and `callApp` read
 * `VISIBLE` (src/apps/installs.ts). A tool offered here is only a list of
 * spaces in which `callApp` will be asked; it checks again.
 */
import type { Space, User } from "@hearth/shared";
import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listAssistantInstalls } from "../apps/installs";
import type { Registry } from "../apps/registry";
import type { Db } from "../db/database";
import { listSpacesForUser } from "../db/people";

/** Claude takes tool names of at most this many characters. */
export const TOOL_NAME_LIMIT = 64;

/**
 * Hearth's own tool. Its name has no "_", and every app's tool has one
 * after the app's ID, which itself has none: no app can take this name.
 */
export const SPACES_TOOL = "hearth-spaces";

/** What the person's own space is called in tools, whatever their language. */
export const PERSONAL_SPACE_LABEL = "Personal";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A JSON Schema, as the object MCP sends: JSON all through. */
export type JsonSchema = { [key: string]: JsonValue };

/** One query or mutation of an app, as a tool: the same for everyone. */
export type ToolRoute = {
  /** `<app ID>_<route>`. An app's ID has no "_", so the first one ends it. */
  name: string;
  appId: string;
  /** The route's name in the app's `server.ts`. */
  route: string;
  kind: "query" | "mutation";
  title: string;
  description: string;
  /** The route's input as JSON Schema, or null for a route that takes none. */
  input: JsonSchema | null;
};

/** Every app route of this build that can be a tool, in a fixed order: apps by ID, then routes as the server file names them. */
export type ToolCatalog = {
  readonly byName: ReadonlyMap<string, ToolRoute>;
  readonly ordered: readonly ToolRoute[];
  /** Why a route is not offered, one line each, for the server to say at start-up. */
  readonly warnings: readonly string[];
};

/**
 * The route's input schema as JSON Schema: what it takes, not what it
 * gives, so that a field with a default may be left out. It only guides the
 * assistant: `callApp` checks the input with the route's own schema.
 */
function inputSchemaOf(schema: z.ZodType): JsonSchema | null {
  try {
    const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
    // It sits inside the tool's own schema, which names the dialect.
    delete json.$schema;
    return json;
  } catch {
    return null;
  }
}

export function createToolCatalog(registry: Registry): ToolCatalog {
  const ordered: ToolRoute[] = [];
  const warnings: string[] = [];
  const apps = [...registry.list()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const app of apps) {
    if (!app.server) continue;
    const appName = app.manifest.name.en;
    for (const [route, definition] of Object.entries(app.server.routes)) {
      if (definition.kind === "job") continue;
      const name = `${app.id}_${route}`;
      if (name.length > TOOL_NAME_LIMIT) {
        warnings.push(
          `Mini-app "${app.id}": the ${definition.kind} "${route}" is not offered to assistants, because its tool name "${name}" is longer than ${TOOL_NAME_LIMIT} characters.`,
        );
        continue;
      }
      let input: JsonSchema | null = null;
      if (definition.input) {
        input = inputSchemaOf(definition.input);
        if (input === null) {
          input = {};
          warnings.push(
            `Mini-app "${app.id}": the input of the ${definition.kind} "${route}" cannot be written as JSON Schema, so assistants are told it takes anything; the route still checks it.`,
          );
        }
      }
      ordered.push({
        name,
        appId: app.id,
        route,
        kind: definition.kind,
        title: `${appName}: ${route}`,
        description: `${definition.description} It belongs to the app "${appName}": ${app.manifest.description.en}`,
        input,
      });
    }
  }
  return { byName: new Map(ordered.map((tool) => [tool.name, tool])), ordered, warnings };
}

/** One of a person's spaces as the tools name it. */
export type SpaceLabel = { label: string; space: Space };

/**
 * The person's spaces, each with the name `space` takes: "Personal" for
 * their own, a group's name for a group, and " (2)", " (3)" after a name
 * an earlier space already has, in the session's order.
 */
export function labelSpaces(spaces: readonly Space[]): SpaceLabel[] {
  const taken = new Set<string>();
  return spaces.map((space) => {
    const base = space.kind === "personal" ? PERSONAL_SPACE_LABEL : space.name;
    let label = base;
    for (let n = 2; taken.has(label); n += 1) label = `${base} (${n})`;
    taken.add(label);
    return { label, space };
  });
}

/** A tool definition as MCP's `tools/list` gives it, with everything Claude asks a tool to have. */
export type ToolDefinition = Tool & {
  title: string;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

/** What an assistant may use for one person right now. */
export type PersonTools = {
  /** Hearth's own tool first, then the apps' in the catalog's order. */
  tools: ToolDefinition[];
  /** For each app tool offered: the spaces it is offered in, by the name `space` takes. */
  offers: Map<string, Map<string, string>>;
  spaces: SpaceLabel[];
  /** What the assistant may do with each app, by space ID, then app ID. */
  access: Map<string, Map<string, "view" | "edit">>;
};

const SPACES_TOOL_DEFINITION: ToolDefinition = {
  name: SPACES_TOOL,
  title: "Hearth: spaces",
  description:
    "Lists the person's spaces in Hearth by the names the other tools' space argument takes, with what the assistant may do in each and the apps it may use there, and says why a space offers nothing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: {
    title: "Hearth: spaces",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function toolsFor(db: Db, registry: Registry, catalog: ToolCatalog, user: User): PersonTools {
  const spaces = labelSpaces(listSpacesForUser(db, user.id));
  const access = new Map<string, Map<string, "view" | "edit">>();
  for (const install of listAssistantInstalls(db, registry, user.id)) {
    let apps = access.get(install.spaceId);
    if (!apps) access.set(install.spaceId, (apps = new Map()));
    apps.set(install.appId, install.access);
  }

  const offers = new Map<string, Map<string, string>>();
  const tools: ToolDefinition[] = [SPACES_TOOL_DEFINITION];
  for (const tool of catalog.ordered) {
    const spacesForTool = new Map<string, string>();
    for (const { space, label } of spaces) {
      const level = access.get(space.id)?.get(tool.appId);
      if (level === "edit" || (level === "view" && tool.kind === "query")) spacesForTool.set(label, space.id);
    }
    if (spacesForTool.size === 0) continue;
    offers.set(tool.name, spacesForTool);
    const labels = [...spacesForTool.keys()];
    const properties: Record<string, JsonSchema> = {
      space: {
        type: "string",
        enum: labels,
        description: `Which of the person's spaces to use: ${labels.map((label) => JSON.stringify(label)).join(", ")}. "${PERSONAL_SPACE_LABEL}" is their own; the others are groups they are in.`,
      },
    };
    if (tool.input) properties.input = tool.input;
    const readOnly = tool.kind === "query";
    tools.push({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties,
        required: tool.input ? ["space", "input"] : ["space"],
        additionalProperties: false,
      },
      annotations: {
        title: tool.title,
        readOnlyHint: readOnly,
        destructiveHint: !readOnly,
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    });
  }
  return { tools, offers, spaces, access };
}

/** What `hearth-spaces` answers: the person's spaces and what the assistant may do in each. */
export function spacesReport(registry: Registry, catalog: ToolCatalog, person: PersonTools, user: User) {
  const LEVELS = { none: "Off", view: "Read only", edit: "Read and change" } as const;
  return {
    you: user.name,
    spaces: person.spaces.map(({ label, space }) => {
      const apps = [...(person.access.get(space.id) ?? new Map<string, "view" | "edit">())].map(([appId, level]) => ({
        app: registry.get(appId)?.manifest.name.en ?? appId,
        id: appId,
        assistantMay: level === "edit" ? "read and change" : "read",
        tools: [...person.offers]
          .filter(([name, offered]) => offered.has(label) && catalog.byName.get(name)?.appId === appId)
          .map(([name]) => name),
      }));
      const note =
        space.assistant === "none"
          ? `The assistant is off in this space. ${space.role === "owner" ? "You are" : "An owner of it is"} the one to switch it on, in Hearth's Settings.`
          : apps.length === 0
            ? "The assistant may use no app here for this person: the space has none they use, they switched them off, or its owners left them out."
            : undefined;
      return {
        space: label,
        kind: space.kind,
        yourRole: space.role,
        assistant: LEVELS[space.assistant],
        apps,
        ...(note === undefined ? {} : { note }),
      };
    }),
  };
}
