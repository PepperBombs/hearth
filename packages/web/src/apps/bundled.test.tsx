import { defineApp } from "@hearth/sdk";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BundledAppsProvider, useBundledApps, type BundledApp } from "./bundled";

const notes: BundledApp = {
  id: "notes",
  manifest: defineApp({
    id: "notes",
    name: { en: "Notes", zh: "笔记" },
    description: { en: "Short notes.", zh: "简短的笔记。" },
    icon: "notebook-text",
    color: "amber",
    widget: { size: "small" },
  }),
  hasPage: false,
  widget: async () => ({ default: () => null }),
};

function Names() {
  const apps = useBundledApps();
  return <p data-testid="names">{apps.map((app) => app.manifest.name.en).join(", ") || "none"}</p>;
}

describe("the apps this build holds", () => {
  it("are the ones the build handed over", () => {
    render(
      <BundledAppsProvider apps={[notes]}>
        <Names />
      </BundledAppsProvider>,
    );
    expect(screen.getByTestId("names").textContent).toBe("Notes");
  });

  it("are none where nothing was handed over", () => {
    render(<Names />);
    expect(screen.getByTestId("names").textContent).toBe("none");
  });
});
