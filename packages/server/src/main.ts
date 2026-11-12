import { apps } from "./apps/registry.generated.js";
import { serveHearth } from "./serve";

// `apps` are the mini-apps this build holds. `hearth-apps sync` wrote the
// list before the build, from the folders named in HEARTH_APPS_DIR at that
// moment (docs/mini-app-contract.md, section A7). A running server reads no
// apps folder: this file is the only one that imports the list.
//
// Everything else a server process does is serveHearth's (src/serve.ts),
// which the tests run with apps of their own.
serveHearth(apps);
