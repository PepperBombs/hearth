import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { AppRegistryError, createRegistry } from "./apps/registry";
import { apps } from "./apps/registry.generated.js";
import { ConfigError, isLoopbackHost, loadConfig, type Config } from "./config";
import { migrate, openDatabase } from "./db/database";

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

// `apps` are the mini-apps this build holds. `hearth-apps sync` wrote the
// list before the build, from the folders named in HEARTH_APPS_DIR at that
// moment (docs/mini-app-contract.md, section A7). A running server reads no
// apps folder: this file is the only one that imports the list.

/**
 * Stops the process when a bundled app is not valid, so that the deploy's
 * trial of a new release fails and the old release keeps running. It runs
 * before the database is opened: a build with a bad app changes nothing.
 */
function checkApps(): void {
  try {
    createRegistry(apps);
  } catch (error) {
    if (error instanceof AppRegistryError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const config = readConfig();
checkApps();
const db = openDatabase(config.dbPath);
for (const migration of migrate(db)) {
  console.log(`Applied database migration ${migration.id} (${migration.name}).`);
}

const app = createApp({ config, db, apps });

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  const host = info.family === "IPv6" ? `[${info.address}]` : info.address;
  console.log(`Hearth ${config.version} is listening on http://${host}:${info.port}`);
  if (config.auth.mode === "dev") {
    console.warn(
      `Sign-in is switched off (HEARTH_AUTH=dev): every request is treated as ${config.auth.devUser}. Never use this on a server.`,
    );
  } else if (!isLoopbackHost(config.host)) {
    console.warn(
      `Listening on ${config.host}, which other machines can reach. Make sure only Cloudflare can connect to this port.`,
    );
  }
  if (config.fetchStandIns !== null) {
    console.warn(
      `Jobs reach no network (HEARTH_FETCH_STANDINS): every ctx.fetch is answered from the stand-ins in ${config.fetchStandIns}. This is for end-to-end tests only.`,
    );
  }
});

server.on("error", (error) => {
  console.error(`Hearth could not listen on ${config.host}:${config.port}: ${error.message}`);
  db.close();
  process.exit(1);
});

let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Do not let an idle keep-alive connection hold the process open.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
