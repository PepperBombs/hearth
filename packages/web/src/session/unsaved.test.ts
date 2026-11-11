import { beforeEach, describe, expect, it } from "vitest";
import { UNSAVED_STORAGE_KEY, forgetUnsaved, noteUnsaved, readUnsaved } from "./unsaved";

describe("unsaved choices", () => {
  beforeEach(() => localStorage.clear());

  it("is empty to begin with", () => {
    expect(readUnsaved(localStorage)).toEqual({});
  });

  it("notes choices, the newest one per setting", () => {
    noteUnsaved(localStorage, { theme: "dark" });
    noteUnsaved(localStorage, { locale: "zh" });
    noteUnsaved(localStorage, { theme: "system" });
    expect(readUnsaved(localStorage)).toEqual({ theme: "system", locale: "zh" });
  });

  it("forgets what was saved and leaves nothing behind", () => {
    noteUnsaved(localStorage, { theme: "dark", locale: "zh" });
    forgetUnsaved(localStorage, { theme: "dark" });
    expect(readUnsaved(localStorage)).toEqual({ locale: "zh" });
    forgetUnsaved(localStorage, { locale: "zh" });
    expect(localStorage.getItem(UNSAVED_STORAGE_KEY)).toBeNull();
  });

  it("keeps a setting that was changed again while the older value was being saved", () => {
    noteUnsaved(localStorage, { theme: "dark" });
    noteUnsaved(localStorage, { theme: "light" });
    forgetUnsaved(localStorage, { theme: "dark" });
    expect(readUnsaved(localStorage)).toEqual({ theme: "light" });
  });

  it("ignores anything it did not write", () => {
    for (const text of ["not json", "[]", '"dark"', '{"theme":"purple","locale":"fr","name":"Sam"}']) {
      localStorage.setItem(UNSAVED_STORAGE_KEY, text);
      expect(readUnsaved(localStorage)).toEqual({});
    }
    localStorage.setItem(UNSAVED_STORAGE_KEY, '{"theme":"dark","locale":"fr"}');
    expect(readUnsaved(localStorage)).toEqual({ theme: "dark" });
  });

  it("works without storage", () => {
    noteUnsaved(undefined, { theme: "dark" });
    forgetUnsaved(undefined, { theme: "dark" });
    expect(readUnsaved(undefined)).toEqual({});
  });
});
