import { defineConfig } from "tsup";

// Entry, format and target are given on the command line in package.json.
export default defineConfig({
  // @hearth/shared is TypeScript source inside this workspace, so it is
  // compiled into the bundle. Everything else stays in node_modules.
  noExternal: ["@hearth/shared"],
});
