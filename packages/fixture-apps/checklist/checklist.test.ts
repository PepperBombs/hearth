import { AppCallError, testApp } from "@hearth/sdk/testing";
import { describe, expect, it } from "vitest";
import server from "./server";

describe("checklist", () => {
  it("lists what was added, oldest first, for everyone in the space", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin", access: "view" });

    sam.mutation("add", { name: "Milk" });
    sam.mutation("add", { name: "Bread", section: "Bakery" });

    expect(lin.query("list")).toMatchObject([
      { name: "Milk", section: "", done: false, createdBy: sam.user.id },
      { name: "Bread", section: "Bakery", done: false, createdBy: sam.user.id },
    ]);
  });

  it("lets only someone who may edit change the list", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin", access: "view" });
    const milk = sam.mutation("add", { name: "Milk" });

    expect(() => lin.mutation("tick", { id: milk.id, done: true })).toThrow("forbidden");
    expect(() => lin.mutation("add", { name: "Eggs" })).toThrow(AppCallError);
    expect(lin.query("list")).toMatchObject([{ name: "Milk", done: false }]);
  });

  it("ticks an item off for everyone, and clears the ticked ones", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin" });
    const milk = sam.mutation("add", { name: "Milk" });
    sam.mutation("add", { name: "Bread" });

    expect(lin.mutation("tick", { id: milk.id, done: true })).toMatchObject({ done: true, updatedBy: lin.user.id });
    expect(sam.query("list").map((item) => [item.name, item.done])).toEqual([
      ["Milk", true],
      ["Bread", false],
    ]);
    expect(sam.mutation("clearTicked")).toBe(1);
    expect(lin.query("list").map((item) => item.name)).toEqual(["Bread"]);
  });

  it("turns down an item without a name, and one that is too long", () => {
    const sam = testApp(server).as();
    expect(() => sam.mutation("add", { name: "  " })).toThrow("invalid_request");
    expect(() => sam.mutation("add", { name: "x".repeat(81) })).toThrow("invalid_request");
    expect(sam.query("list")).toEqual([]);
  });

  it("keeps the space's sections for everyone and each person's own switch for them", () => {
    const app = testApp(server);
    const sam = app.as({ name: "Sam" });
    const lin = app.as({ name: "Lin", access: "view" });

    expect(sam.saveSettings({ sections: ["Fruit", "Bakery"], hideDone: true })).toEqual({
      sections: ["Fruit", "Bakery"],
      hideDone: true,
    });
    expect(lin.settings()).toEqual({ sections: ["Fruit", "Bakery"], hideDone: false });
    expect(() => lin.saveSettings({ sections: [] })).toThrow("forbidden");
    expect(lin.saveSettings({ hideDone: true })).toEqual({ sections: ["Fruit", "Bakery"], hideDone: true });
  });
});
