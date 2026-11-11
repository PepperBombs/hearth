/**
 * The setup file of the test run `hearth-apps test` starts
 * (vitest.apps.config.ts at this package's root): before each test file of
 * a mini-app, `testApp` from `@hearth/sdk/testing` is given the framework's
 * implementation, the real store over an in-memory database (app-testing.ts).
 */
import { provideTestApp } from "@hearth/sdk/testing/host";
import { createTestApp } from "./app-testing";

provideTestApp(createTestApp);
