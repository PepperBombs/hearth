import { serveHearth } from "./serve";

// Everything a server process does is serveHearth's (src/serve.ts), which
// the tests run piece by piece.
serveHearth();
