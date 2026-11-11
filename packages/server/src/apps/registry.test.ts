import { defineApp, type Manifest } from "@hearth/sdk";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FIXTURE_APPS, testConfig, testDatabase } from "../testing";
import { AppRegistryError, createRegistry, type BundledApp } from "./registry";

const notes = defineApp({
  id: "notes",
  name: { en: "Notes", zh: "笔记" },
  description: { en: "Short notes.", zh: "简短的笔记。" },
  icon: "notebook-text",
  color: "amber",
  widget: { size: "small" },
});

const bundled = (manifest: Manifest, id = manifest.id): BundledApp => ({ id, manifest, hasPage: false });

/** The problems createRegistry reports for these apps; fails if it reports none. */
function problemsOf(apps: readonly BundledApp[]): readonly string[] {
  try {
    createRegistry(apps);
  } catch (error) {
    if (error instanceof AppRegistryError) return error.problems;
    throw error;
  }
  throw new Error("createRegistry accepted these apps.");
}

describe("createRegistry", () => {
  it("accepts no apps at all", () => {
    const registry = createRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.has("checklist")).toBe(false);
    expect(registry.get("checklist")).toBeUndefined();
  });

  it("accepts the framework's own sample apps", () => {
    const registry = createRegistry(FIXTURE_APPS);
    expect(registry.list().map((app) => app.id)).toEqual(["checklist", "feed"]);
    expect(registry.get("checklist")?.manifest.name).toEqual({ en: "Checklist", zh: "清单" });
    // One keeps rows and one does not.
    expect(registry.get("checklist")?.server).toBeDefined();
    expect(registry.get("feed")?.server).toBeUndefined();
  });

  it("finds an app by its ID and no other", () => {
    const registry = createRegistry([...FIXTURE_APPS, { ...bundled(notes), hasPage: true }]);
    expect(registry.has("notes")).toBe(true);
    expect(registry.get("notes")?.hasPage).toBe(true);
    expect(registry.has("Notes")).toBe(false);
    expect(registry.has("")).toBe(false);
    // Names that every object has are not apps.
    expect(registry.has("constructor")).toBe(false);
    expect(registry.get("toString")).toBeUndefined();
  });

  it("refuses a manifest with a language missing, naming the app and the place", () => {
    const manifest = { ...notes, name: { en: "Notes" } } as unknown as Manifest;
    const problems = problemsOf([bundled(manifest)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('App "notes"');
    expect(problems[0]).toContain("name.zh");
  });

  it.each([
    ["an unknown icon", { icon: "rocket" }, "icon"],
    ["an unknown colour", { color: "red" }, "color"],
    ["an empty description", { description: { en: "Short notes.", zh: " " } }, "description.zh"],
    ["a property it does not know", { hasPage: true }, "hasPage"],
  ])("refuses a manifest with %s", (_label, change, where) => {
    const problems = problemsOf([bundled({ ...notes, ...change } as unknown as Manifest)]);
    expect(problems.join("\n")).toContain(where);
  });

  it("refuses an app that has no manifest", () => {
    const problems = problemsOf([{ id: "ghost", manifest: undefined as unknown as Manifest, hasPage: false }]);
    expect(problems[0]).toContain('App "ghost"');
  });

  it("refuses an ID that differs from the manifest's", () => {
    const problems = problemsOf([bundled(notes, "notebook")]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('App "notebook"');
    expect(problems[0]).toContain('"notes"');
  });

  it("refuses the same ID twice", () => {
    const problems = problemsOf([bundled(notes), ...FIXTURE_APPS, bundled(notes)]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('App "notes" is in this build twice');
  });

  it("reports every problem at once, in a message that can be shown as it is", () => {
    const first = { ...notes, icon: "rocket", color: "red" } as unknown as Manifest;
    const second = { ...notes, id: "Bad ID" } as unknown as Manifest;
    let caught: unknown;
    try {
      createRegistry([bundled(first), bundled(second), ...FIXTURE_APPS]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppRegistryError);
    const error = caught as AppRegistryError;
    expect(error.problems).toHaveLength(3);
    expect(error.message).toContain("Hearth cannot start");
    for (const problem of error.problems) expect(error.message).toContain(problem);
  });
});

describe("createApp", () => {
  it("checks every manifest before anything is served", () => {
    const bad = { ...notes, name: { en: "Notes", zh: "" } } as unknown as Manifest;
    const build = () =>
      createApp({ config: testConfig(), db: testDatabase(), apps: [...FIXTURE_APPS, bundled(bad)] });
    expect(build).toThrow(AppRegistryError);
    expect(build).toThrow(/App "notes": manifest name\.zh/);
  });

  it("starts with valid apps", () => {
    expect(() =>
      createApp({ config: testConfig(), db: testDatabase(), apps: [...FIXTURE_APPS, bundled(notes)] }),
    ).not.toThrow();
  });
});
