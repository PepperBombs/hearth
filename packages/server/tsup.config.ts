import { defineConfig } from "tsup";

// Entry, format and target are given on the command line in package.json.
export default defineConfig({
  // @hearth/shared and @hearth/sdk are TypeScript source inside this
  // workspace, so they are compiled into the bundle. Everything else stays
  // in node_modules.
  noExternal: ["@hearth/shared", "@hearth/sdk"],
});
