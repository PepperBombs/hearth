/**
 * The framework's side of `@hearth/sdk/testing`: `testApp(server)`, with
 * which a mini-app's own tests call its queries and mutations.
 *
 * A test's call goes through the functions the server's routes use:
 * `callApp` (calls.ts) for a query or mutation, with its access check,
 * input check, `ctx`, store and transaction, and `readAppSettings` and
 * `changeAppSettings` (settings.ts) for settings. What differs is the
 * database, which is the test's own: in memory, migrated like the real one.
 * What a test arranges (the space, the people in it, what each may do,
 * their language) goes through the functions that create groups, add
 * people and change access, so that a test sees a world the server could
 * hold.
 *
 * The app is checked first by `createRegistry`, as at start-up, so an app
 * that would stop the server fails its tests too.
 *
 * `hearth-apps test` installs this for the SDK in the setup file of its test
 * run (app-testing.setup.ts, named by vitest.apps.config.ts). It is not part
 * of the running server.
 *
 * Design: docs/mini-app-contract.md, section A9.
 */
import type { Manifest } from "@hearth/sdk";
import type { Json } from "@hearth/sdk/server";
import { AppCallError, type TestAppOptions, type TestPerson } from "@hearth/sdk/testing";
import type { TestAppHandle, TestCallerHandle } from "@hearth/sdk/testing/host";
import { appSettingsPatchSchema, type Locale, type SpaceKind, type User } from "@hearth/shared";
import { migrate, openDatabase, type Db } from "../db/database";
import { createUserWithPersonalSpace, findUserById, listSpacesForUser, updatePreferences } from "../db/people";
import { addMember, createGroup } from "../groups/members";
import { Refusal } from "../http/errors";
import { callApp } from "./calls";
import { addApp, setAppAccess } from "./installs";
import { AppRegistryError, createRegistry, type Registry } from "./registry";
import { changeAppSettings, readAppSettings } from "./settings";

/** Who calls when a test names nobody. */
export const DEFAULT_PERSON = "Sam";
/** The group an app is tested in. Sample data. */
export const TEST_GROUP_NAME = "Family";
/** The group's owner, who adds the app and decides who may use it, and never calls it. */
const OWNER_EMAIL = "owner@example.com";

/** A test world may create groups and add people, whatever the server's policy says. */
const RIGHTS = { canCreateGroups: true, canInvitePeople: true } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as it arrives after a trip through JSON, as a request body brings it. */
function throughJson(value: unknown): Json | undefined {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : (JSON.parse(text) as Json);
}

/** Runs `work`, turning the server's refusal into the error a test sees. */
function answered<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (
      error instanceof Refusal &&
      (error.code === "invalid_request" || error.code === "forbidden" || error.code === "not_found" || error.code === "conflict")
    ) {
      throw new AppCallError(error.status, error.code, error.message);
    }
    throw error;
  }
}

/** The app as the build would hand it to the server, checked as the server checks it at start-up. */
function registryFor(server: unknown): { registry: Registry; manifest: Manifest; appId: string } {
  const manifest = isRecord(server) ? server.manifest : undefined;
  if (!isRecord(manifest) || typeof manifest.id !== "string") {
    throw new TypeError(
      "testApp takes what an app's server.ts exports by default (export default app.routes({ ... })): import server from \"./server\".",
    );
  }
  let registry: Registry;
  try {
    registry = createRegistry([{ id: manifest.id, manifest: manifest as Manifest, hasPage: false, server }]);
  } catch (error) {
    if (!(error instanceof AppRegistryError)) throw error;
    throw new Error(
      [
        "testApp: the server would not start with this app:",
        ...error.problems.map((problem) => `  - ${problem}`),
      ].join("\n"),
      { cause: error },
    );
  }
  const app = registry.get(manifest.id);
  if (!app) throw new Error("testApp: the app went missing from its own registry.");
  return { registry, manifest: app.manifest, appId: app.id };
}

/** What the test asked for in `as(...)`, checked. */
function readPerson(person: TestPerson | undefined): Required<TestPerson> {
  if (person !== undefined && !isRecord(person)) {
    throw new TypeError("testApp: as(...) takes { name?, access?, locale? }, or nothing.");
  }
  const name = person?.name ?? DEFAULT_PERSON;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError("testApp: as({ name }) needs a name that is not empty.");
  }
  const access = person?.access ?? "edit";
  if (access !== "view" && access !== "edit") throw new TypeError('testApp: as({ access }) is "view" or "edit".');
  const locale: Locale = person?.locale ?? "en";
  if (locale !== "en" && locale !== "zh") throw new TypeError('testApp: as({ locale }) is "en" or "zh".');
  return { name, access, locale };
}

/** The kind of space the app goes into: what the test asked for, else a group if the manifest allows one. */
function kindFor(manifest: Manifest, options: TestAppOptions): SpaceKind {
  const allowed: readonly SpaceKind[] = manifest.spaces ?? ["personal", "group"];
  const kind = options.space ?? (allowed.includes("group") ? "group" : "personal");
  if (kind !== "personal" && kind !== "group") throw new TypeError('testApp: { space } is "personal" or "group".');
  if (!allowed.includes(kind)) {
    throw new Error(`testApp: "${manifest.id}" cannot be added to a ${kind} space; its manifest's spaces leave that kind out.`);
  }
  return kind;
}

/**
 * Makes a world for one app: a database of its own, migrated like the
 * server's, with the app added to one space. In a group, the space's owner
 * adds the app with "only me for now", and everyone a test names joins as
 * a member whose access the owner sets before each of their calls. In a
 * personal space the one person a test names is its owner.
 */
export function createTestApp(server: unknown, options: TestAppOptions = {}): TestAppHandle {
  if (!isRecord(options)) throw new TypeError("testApp: its options are { space? }, or nothing.");
  const { registry, manifest, appId } = registryFor(server);
  const kind = kindFor(manifest, options);
  const db: Db = openDatabase(":memory:");
  migrate(db);

  let personCount = 0;
  const newPerson = (name: string, locale: Locale): User => {
    personCount += 1;
    const user = createUserWithPersonalSpace(db, { email: `person-${personCount}@example.com`, locale });
    return updatePreferences(db, user.id, { name }) ?? user;
  };

  /** The space the app is in; for a personal space, made with its person at the first `as(...)`. */
  let spaceId: string | null = null;
  let owner: User | null = null;
  const people = new Map<string, User>();

  if (kind === "group") {
    owner = createUserWithPersonalSpace(db, { email: OWNER_EMAIL, locale: "en" });
    spaceId = createGroup(db, RIGHTS, { userId: owner.id, name: TEST_GROUP_NAME }).id;
    addApp(db, registry, { userId: owner.id, spaceId, appId });
  }

  /** The person a test names: someone already there, or someone new in the space. */
  function personNamed(name: string, locale: Locale): { user: User; spaceId: string } {
    const known = people.get(name);
    if (known && spaceId !== null) return { user: known, spaceId };
    if (kind === "personal") {
      if (spaceId !== null) {
        const [only] = people.keys();
        throw new Error(
          `testApp: a personal space has one person, ${only}; "${name}" cannot be in it. Test two people in a group: testApp(server, { space: "group" }), where the manifest allows one.`,
        );
      }
      const user = newPerson(name, locale);
      const personal = listSpacesForUser(db, user.id).find((space) => space.kind === "personal");
      if (!personal) throw new Error("testApp: a new person has no personal space.");
      addApp(db, registry, { userId: user.id, spaceId: personal.id, appId });
      people.set(name, user);
      spaceId = personal.id;
      return { user, spaceId };
    }
    if (!owner || spaceId === null) throw new Error("testApp: the group was not made.");
    const user = newPerson(name, locale);
    addMember(db, RIGHTS, { userId: owner.id, spaceId, email: user.email });
    people.set(name, user);
    return { user, spaceId };
  }

  function caller(person: TestPerson | undefined): TestCallerHandle {
    const { name, access, locale } = readPerson(person);
    if (kind === "personal" && access === "view") {
      throw new Error(
        'testApp: in a personal space its one person may always edit. Test view access in a group: testApp(server, { space: "group" }), where the manifest allows one.',
      );
    }
    const { user, spaceId: space } = personNamed(name, locale);

    /** Gives the person this caller's access and language, as the owner and the person themselves would. */
    const arrange = (): User => {
      if (kind === "group" && owner) {
        setAppAccess(db, registry, {
          userId: owner.id,
          spaceId: space,
          appId,
          change: { members: { [user.id]: access } },
        });
      }
      updatePreferences(db, user.id, { locale });
      const current = findUserById(db, user.id);
      if (!current) throw new Error("testApp: a person went missing.");
      return current;
    };

    const call = (kindOfRoute: "query" | "mutation", route: string, input: unknown): unknown => {
      const signedIn = arrange();
      const sent = input === undefined ? undefined : throughJson(input);
      const answer = answered(() =>
        callApp(db, registry, { user: signedIn, spaceId: space, appId, kind: kindOfRoute, name: route, input: sent }),
      );
      return (JSON.parse(answer) as { output?: unknown }).output;
    };

    const merged = (settings: { space: Record<string, unknown>; user: Record<string, unknown> }) => ({
      ...settings.space,
      ...settings.user,
    });

    return Object.freeze({
      user: Object.freeze({ id: user.id, name: user.name }),
      query: (route: string, input?: unknown) => call("query", route, input),
      mutation: (route: string, input?: unknown) => call("mutation", route, input),
      settings: () => {
        const signedIn = arrange();
        return merged(answered(() => readAppSettings(db, registry, { userId: signedIn.id, spaceId: space, appId })));
      },
      saveSettings: (values: Record<string, unknown>) => {
        const signedIn = arrange();
        if (!isRecord(values)) throw new TypeError("testApp: saveSettings takes the settings to save by name.");
        // As the settings form sends them: each under its scope. A name the
        // manifest does not declare goes with a person's own, where the
        // server turns it down for what it is rather than for want of edit.
        const declared = manifest.settings ?? {};
        const patch: { space: Record<string, unknown>; user: Record<string, unknown> } = { space: {}, user: {} };
        for (const [name, value] of Object.entries(throughJson(values) as Record<string, unknown>)) {
          const scope = Object.hasOwn(declared, name) ? (declared[name]?.scope ?? "user") : "user";
          patch[scope][name] = value;
        }
        const parsed = appSettingsPatchSchema.safeParse(patch);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
          throw new AppCallError(400, "invalid_request", `${where}${issue?.message ?? "The request is not valid."}`);
        }
        return merged(
          answered(() =>
            changeAppSettings(db, registry, { userId: signedIn.id, spaceId: space, appId, patch: parsed.data }),
          ),
        );
      },
    });
  }

  const space = Object.freeze({ kind, name: kind === "group" ? TEST_GROUP_NAME : "" });
  return Object.freeze({ space, as: caller });
}
