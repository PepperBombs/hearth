import { defineConfig } from "vitest/config";

/**
 * Two kinds of test: the manifest and its schema run in Node; the UI kit in
 * src/web needs a page to render into.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "sdk",
          include: ["src/**/*.test.ts"],
          exclude: ["src/web/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "sdk/web",
          include: ["src/web/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["src/web/test-setup.ts"],
        },
      },
    ],
  },
});
