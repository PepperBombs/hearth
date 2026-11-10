import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** Every file under `dir`, as paths relative to it with forward slashes. */
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [relative(base, full).split(sep).join("/")];
  });
}

/**
 * Writes dist/sw.js from the hand-written src/sw/sw.js once the build is on disk.
 * It fills in the list of static shell files and a version derived from their
 * contents, so a new build installs a new cache and drops the old one.
 */
function serviceWorker(): Plugin {
  let root = "";
  let outDir = "";
  return {
    name: "hearth:service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!existsSync(join(outDir, "index.html"))) return;
      const files = listFiles(outDir)
        .filter((file) => file !== "sw.js" && !file.endsWith(".map"))
        .sort();
      const hash = createHash("sha256");
      for (const file of files) {
        hash.update(file);
        hash.update(readFileSync(join(outDir, file)));
      }
      const version = hash.digest("hex").slice(0, 12);
      // The page itself is cached as "/", never as "/index.html".
      const urls = ["/", ...files.filter((file) => file !== "index.html").map((file) => `/${file}`)];
      const template = readFileSync(join(root, "src/sw/sw.js"), "utf8");
      const output = template
        .replace('"__HEARTH_SHELL_VERSION__"', JSON.stringify(version))
        .replace('["__HEARTH_SHELL_FILES__"]', JSON.stringify(urls));
      if (output === template) throw new Error("src/sw/sw.js is missing its placeholders");
      writeFileSync(join(outDir, "sw.js"), output);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:4310" },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
    css: false,
  },
});
