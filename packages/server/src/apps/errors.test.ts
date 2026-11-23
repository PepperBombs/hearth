/**
 * The two errors that came from the SDK's server side (its src/server.ts,
 * whose tests these were): FetchError, why `hearth.fetch` gave no answer
 * (fetch.ts), and AppError, how the store turns a request down (store.ts).
 * As in the store's tests, the `@ts-expect-error` lines are checked by
 * `pnpm typecheck`, not by the test runner.
 */
import { describe, expect, it } from "vitest";
import { FETCH_ERROR_CODES, FetchError } from "./fetch";
import { APP_ERROR_CODES, AppError } from "./store";

describe("FetchError", () => {
  it("carries one of five codes and a message", () => {
    const error = new FetchError("refused", "feeds.example.com is not one of the hosts the manifest lists.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("FetchError");
    expect(error.code).toBe("refused");
    expect(error.message).toBe("feeds.example.com is not one of the hosts the manifest lists.");
    expect(FETCH_ERROR_CODES).toEqual(["refused", "timeout", "too_large", "network", "stopped"]);
  });

  it("cannot be given another code", () => {
    // @ts-expect-error not a way for a fetch to fail
    expect(new FetchError("forbidden", "No.").code).toBe("forbidden");
  });
});

describe("AppError", () => {
  it("carries one of three codes and a message", () => {
    const error = new AppError("conflict", "That name is taken.");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AppError");
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("That name is taken.");
    expect(APP_ERROR_CODES).toEqual(["invalid_request", "not_found", "conflict"]);
  });

  it("cannot be given a code the store does not answer with", () => {
    // @ts-expect-error forbidden is the access check's answer, never the store's
    expect(new AppError("forbidden", "No.").code).toBe("forbidden");
  });
});
