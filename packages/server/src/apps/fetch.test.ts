/**
 * ctx.fetch's rules, its pace and its transports, without a network: the
 * rules in front of a transport written here, Node's transport in front of a
 * made-up fetch that answers with real Response objects, and the stand-in
 * file in a temporary folder. Time is a clock that moves only when told.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchError } from "@hearth/sdk/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_TIME_LIMIT_MS,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  PACE_MS,
  USER_AGENT,
  createPace,
  fetchFor,
  nodeTransport,
  outboundFor,
  type FetchFunction,
  type Outbound,
  type Transport,
  type TransportRequest,
} from "./fetch";
import { fakeClock, settle } from "./test-clock";

const HOSTS = ["api.github.com", "feeds.example.com"];
const SEARCH = "https://api.github.com/search/repositories";
const FEED = "https://feeds.example.com/headlines.json";

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

/** A promise, and whether it has settled yet; its rejection counts as handled. */
function watch<T>(promise: Promise<T>) {
  const watched = { promise, settled: false };
  promise.then(
    () => (watched.settled = true),
    () => (watched.settled = true),
  );
  return watched;
}

/** The FetchError a call to ctx.fetch rejects with. */
async function failure(promise: Promise<unknown>): Promise<FetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof FetchError) return error;
    throw error;
  }
  throw new Error("ctx.fetch gave an answer.");
}

/** ctx.fetch for one run, in front of `transport`, with what it sent recorded. */
function setUp(options: { transport?: Transport; hosts?: readonly string[]; paced?: boolean } = {}) {
  const fake = fakeClock();
  const run = new AbortController();
  const requests: TransportRequest[] = [];
  const answer: Transport = options.transport ?? (async () => new Response("ok"));
  const outbound: Outbound = {
    transport: (request) => {
      requests.push(request);
      return answer(request);
    },
    pace: options.paced ? createPace(fake.clock) : null,
    clock: fake.clock,
  };
  return { fetch: fetchFor(outbound, { hosts: options.hosts ?? HOSTS, signal: run.signal }), fake, run, requests };
}

/**
 * A made-up fetch for Node's transport. It answers with what `answer` gives,
 * or never ("never"), and like Node's own it rejects with its signal's
 * reason once that aborts before the answer.
 */
function madeUpFetch(answer: (url: string) => Response | Promise<Response> | "never") {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFunction: FetchFunction = (url, init) => {
    calls.push({ url, init });
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      const result = answer(url);
      if (result !== "never") Promise.resolve(result).then(resolve, reject);
    });
  };
  return { fetchFunction, calls };
}

/** ctx.fetch through Node's transport and a made-up fetch. */
function throughNode(answer: (url: string) => Response | Promise<Response> | "never", paced = false) {
  const { fetchFunction, calls } = madeUpFetch(answer);
  return { ...setUp({ transport: nodeTransport(fetchFunction), paced }), calls };
}

const bytes = (text: string) => new TextEncoder().encode(text);

/* -------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------- */

describe("ctx.fetch refuses, before sending anything,", () => {
  it.each([
    ["an http address", "http://api.github.com/search", "Only https addresses are fetched, not http ones: http://api.github.com/search"],
    ["an ftp address", "ftp://feeds.example.com/x", "not ftp ones"],
    ["a data address", "data:text/plain,hello", "not data ones."],
    ["a file address", "file:///etc/passwd", "not file ones."],
    ["a host the manifest does not list", "https://example.com/", "example.com is not a host this app's manifest lists in network (api.github.com, feeds.example.com)"],
    ["a host below a listed one", "https://evil.api.github.com/", "evil.api.github.com is not a host"],
    ["a listed host's parent", "https://github.com/", "github.com is not a host"],
    ["a listed host with a dot at its end", "https://api.github.com./", "api.github.com. is not a host"],
    ["an IP address", "https://140.82.112.6/", "140.82.112.6 is not a host"],
    ["an IPv6 address", "https://[::1]/", "[::1] is not a host"],
    ["a port", "https://api.github.com:8443/search", "An address may not name a port: https://api.github.com:8443/search"],
    ["a user name", "https://someone@api.github.com/", "An address may not hold a user name or password"],
    ["a password", "https://someone:secret@api.github.com/", "An address may not hold a user name or password: https://api.github.com/"],
    ["an address that is not whole", "/search/repositories", 'and "/search/repositories" is not one'],
    ["text that is no address", "api.github.com/search", "ctx.fetch takes a whole address"],
  ])("%s", async (_label, url, words) => {
    const { fetch, requests } = setUp();
    const error = await failure(fetch(url));
    expect(error.code).toBe("refused");
    expect(error.message).toContain(words);
    expect(error.message).not.toContain("secret");
    expect(requests).toEqual([]);
  });

  it("an address that is not text", async () => {
    const { fetch, requests } = setUp();
    for (const url of [new URL(SEARCH), undefined, 42]) {
      expect(await failure(fetch(url as unknown as string))).toMatchObject({
        code: "refused",
        message: expect.stringContaining("ctx.fetch takes its address as text"),
      });
    }
    expect(requests).toEqual([]);
  });

  it("every address, for an app whose manifest lists no hosts", async () => {
    const { fetch, requests } = setUp({ hosts: [] });
    expect(await failure(fetch(SEARCH))).toMatchObject({
      code: "refused",
      message: expect.stringContaining("This app's manifest lists no hosts in network, so its jobs fetch from none"),
    });
    expect(requests).toEqual([]);
  });

  it.each([
    ["a method", { method: "POST" }, 'not "method": a job only sends GET requests'],
    ["a body", { headers: {}, body: "{}" }, 'not "body"'],
    ["a signal", { signal: new AbortController().signal }, 'not "signal"'],
    ["null", null, "ctx.fetch takes { headers } as its second argument, or nothing."],
    ["text", "accept: application/json", "ctx.fetch takes { headers }"],
    ["a list", [], "ctx.fetch takes { headers }"],
    ["headers as a Headers object", { headers: new Headers({ accept: "text/html" }) }, "headers must be an object of names and values"],
    ["headers as a list of pairs", { headers: [["accept", "text/html"]] }, "headers must be an object of names and values"],
    ["headers as text", { headers: "accept: text/html" }, "headers must be an object of names and values"],
  ])("a second argument with %s", async (_label, init, words) => {
    const { fetch, requests } = setUp();
    expect(await failure(fetch(SEARCH, init as never))).toMatchObject({ code: "refused", message: expect.stringContaining(words) });
    expect(requests).toEqual([]);
  });

  it.each([
    "Authorization",
    "Cookie",
    "Host",
    "Origin",
    "Referer",
    "User-Agent",
    "Proxy-Authorization",
    "Content-Type",
    "Accept-Encoding",
    "Connection",
    "Forwarded",
    "X-Forwarded-For",
    "x-forwarded-host",
    "X-Forwarded-Proto",
    "x-real-ip",
    "X-Real-IP",
    "Cf-Access-Jwt-Assertion",
    "Cf-Connecting-Ip",
    "If-Match",
    "Range",
  ])("the header %s", async (name) => {
    const { fetch, requests } = setUp();
    expect(await failure(fetch(SEARCH, { headers: { [name]: "anything" } }))).toMatchObject({
      code: "refused",
      message: expect.stringContaining(`A job may not send the header ${name.toLowerCase()}.`),
    });
    expect(requests).toEqual([]);
  });

  it.each([
    ["a name that is no header name", { "x bad": "1" }, '"x bad" is not a header name.'],
    ["an empty name", { "": "1" }, '"" is not a header name.'],
    ["a header given twice", { Accept: "text/html", accept: "application/json" }, "The header accept is given twice."],
    ["a line break in a value", { "x-note": "one\r\nx-forwarded-for: 203.0.113.9" }, "The value of the header x-note must be text of visible ASCII"],
    ["a zero byte in a value", { "x-note": "a\u0000b" }, "The value of the header x-note"],
    ["a value that is not ASCII", { "accept-language": "中文" }, "The value of the header accept-language"],
    ["a value that is not text", { "x-count": 5 }, "The value of the header x-count"],
  ])("%s", async (_label, headers, words) => {
    const { fetch, requests } = setUp();
    expect(await failure(fetch(SEARCH, { headers: headers as never }))).toMatchObject({
      code: "refused",
      message: expect.stringContaining(words),
    });
    expect(requests).toEqual([]);
  });
});

describe("ctx.fetch sends", () => {
  it("User-Agent: Hearth and the headers a job may add, in lower case, and nothing else", async () => {
    const { fetch, requests, fake } = setUp();
    await fetch(`${SEARCH}?q=stars%3A%3E1#results`, {
      headers: {
        Accept: "application/vnd.github+json",
        "Accept-Language": "en",
        "If-None-Match": '"abc"',
        "If-Modified-Since": "Wed, 11 Nov 2026 08:00:00 GMT",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${SEARCH}?q=stars%3A%3E1`);
    expect(requests[0]?.headers).toEqual({
      "user-agent": USER_AGENT,
      accept: "application/vnd.github+json",
      "accept-language": "en",
      "if-none-match": '"abc"',
      "if-modified-since": "Wed, 11 Nov 2026 08:00:00 GMT",
      "x-github-api-version": "2022-11-28",
    });
    expect(USER_AGENT).toBe("Hearth");
    // The time limit of the request was let go once the answer was in.
    expect(fake.pending()).toBe(0);
  });

  it("User-Agent alone when the job adds no header", async () => {
    const { fetch, requests } = setUp();
    await fetch(SEARCH);
    await fetch(SEARCH, {});
    await fetch(SEARCH, { headers: {} });
    expect(requests.map((request) => request.headers)).toEqual([
      { "user-agent": "Hearth" },
      { "user-agent": "Hearth" },
      { "user-agent": "Hearth" },
    ]);
  });

  it("to the address as it was checked: the default port and capitals change nothing", async () => {
    const { fetch, requests } = setUp();
    await fetch("https://API.GitHub.com:443/search/repositories");
    // A backslash ends the host in an https address, so this stays on api.github.com.
    await fetch("https://api.github.com\\@example.com/");
    expect(requests.map((request) => request.url)).toEqual([SEARCH, "https://api.github.com/@example.com/"]);
  });

  it("through Node's fetch: one GET with those headers, no redirect followed and no cookies", async () => {
    const { fetch, calls } = throughNode(() => new Response("ok"));
    const answer = await fetch(SEARCH, { headers: { accept: "application/json" } });
    expect(answer.text).toBe("ok");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(SEARCH);
    expect(Object.keys(call.init).sort()).toEqual(["credentials", "headers", "method", "redirect", "signal"]);
    expect(call.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { "user-agent": "Hearth", accept: "application/json" },
    });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("ctx.fetch's answer", () => {
  it("is whole: its address, status, headers in lower case without set-cookie, text and json()", async () => {
    const { fetch } = throughNode(
      () =>
        new Response(JSON.stringify({ total_count: 2 }), {
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": "session=1",
            "X-RateLimit-Remaining": "9",
          },
        }),
    );
    const answer = await fetch(`${SEARCH}?q=x`);
    expect(answer).toMatchObject({ url: `${SEARCH}?q=x`, status: 200, ok: true, text: '{"total_count":2}' });
    expect(answer.headers).toEqual({ "content-type": "application/json", "x-ratelimit-remaining": "9" });
    expect(answer.json()).toEqual({ total_count: 2 });
    expect(Object.isFrozen(answer)).toBe(true);
  });

  it("leaves out set-cookie2 too, the older name for a cookie", async () => {
    const { fetch } = throughNode(
      () => new Response("ok", { headers: { "Set-Cookie2": 'session=1; Version="1"', "Set-Cookie": "other=2", Etag: '"x"' } }),
    );
    expect((await fetch(FEED)).headers).toEqual({ "content-type": "text/plain;charset=UTF-8", etag: '"x"' });
  });

  it.each([
    [403, '{"message":"API rate limit exceeded"}'],
    [404, "Not Found"],
    [429, "Too Many Requests"],
    [500, "Something went wrong"],
  ])("with status %i is an answer like any other", async (status, text) => {
    const { fetch } = throughNode(() => new Response(text, { status }));
    expect(await fetch(SEARCH)).toMatchObject({ status, ok: false, text });
  });

  it("is read as UTF-8, also where a chunk ends inside a character", async () => {
    const whole = bytes("热门仓库 ✓");
    const { fetch } = throughNode(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(whole.slice(0, 1));
              controller.enqueue(whole.slice(1, 5));
              controller.enqueue(whole.slice(5));
              controller.close();
            },
          }),
        ),
    );
    expect((await fetch(FEED)).text).toBe("热门仓库 ✓");
  });

  it("says, from json(), that it is not JSON and where it came from", async () => {
    const { fetch } = throughNode(() => new Response("<html>Sign in to the network</html>"));
    const answer = await fetch(FEED);
    expect(() => answer.json()).toThrow(SyntaxError);
    expect(() => answer.json()).toThrow(`The answer from ${FEED} is not JSON`);
  });

  it("has an empty text when it has no body", async () => {
    const { fetch } = throughNode(() => new Response(null, { status: 204 }));
    expect(await fetch(FEED)).toMatchObject({ status: 204, ok: true, text: "" });
  });
});

describe("ctx.fetch follows redirects", () => {
  it.each([301, 302, 303, 307, 308])("of status %i on the same host, dropping the redirect's own body", async (status) => {
    let dropped = false;
    const { fetch, calls } = throughNode((url) =>
      url.endsWith("/old")
        ? new Response(new ReadableStream({ cancel: () => void (dropped = true) }), {
            status,
            headers: { location: "/new?page=2" },
          })
        : new Response("moved here"),
    );
    const answer = await fetch("https://feeds.example.com/old", { headers: { accept: "text/plain" } });
    expect(answer).toMatchObject({ url: "https://feeds.example.com/new?page=2", status: 200, text: "moved here" });
    expect(calls.map((call) => call.url)).toEqual(["https://feeds.example.com/old", "https://feeds.example.com/new?page=2"]);
    expect(calls[1]?.init.headers).toEqual({ "user-agent": "Hearth", accept: "text/plain" });
    await settle();
    expect(dropped).toBe(true);
  });

  it(`up to ${MAX_REDIRECTS} times, and refuses one more`, async () => {
    const chain = (last: number) =>
      throughNode((url) => {
        const step = Number(url.slice(url.lastIndexOf("/") + 2));
        return step < last
          ? new Response(null, { status: 302, headers: { location: `https://feeds.example.com/r${step + 1}` } })
          : new Response(`end of r${step}`);
      });
    const three = chain(3);
    expect(await three.fetch("https://feeds.example.com/r0")).toMatchObject({
      url: "https://feeds.example.com/r3",
      text: "end of r3",
    });
    expect(three.calls).toHaveLength(4);

    const four = chain(4);
    expect(await failure(four.fetch("https://feeds.example.com/r0"))).toMatchObject({
      code: "refused",
      message: "https://feeds.example.com/r0 redirects more than 3 times.",
    });
    expect(four.calls).toHaveLength(4);
  });

  it.each([
    ["another host the manifest lists", "https://api.github.com/search"],
    ["a host the manifest does not list", "https://example.com/feed"],
    ["http on the same host", "http://feeds.example.com/new"],
    ["another port on the same host", "https://feeds.example.com:8443/new"],
    ["a user name on the same host", "https://someone@feeds.example.com/new"],
    ["no address at all", "https://"],
  ])("but never to %s", async (_label, location) => {
    const { fetch, calls } = throughNode((url) =>
      url.endsWith("/old") ? new Response(null, { status: 301, headers: { location } }) : new Response("followed"),
    );
    const error = await failure(fetch("https://feeds.example.com/old"));
    expect(error.code).toBe("refused");
    expect(error.message).toMatch(/^https:\/\/feeds\.example\.com\/old redirects to .*(which is not followed|not valid)/);
    expect(calls).toHaveLength(1);
  });

  it.each([300, 304, 305])("only of the five redirect statuses: a %i is the answer, its location and all", async (status) => {
    const { fetch, calls } = throughNode((url) =>
      url.endsWith("/choices")
        ? new Response(status === 304 ? null : "choose one", { status, headers: { location: "/elsewhere" } })
        : new Response("followed"),
    );
    expect(await fetch("https://feeds.example.com/choices")).toMatchObject({
      url: "https://feeds.example.com/choices",
      status,
      ok: false,
      headers: { location: "/elsewhere" },
      text: status === 304 ? "" : "choose one",
    });
    expect(calls.map((call) => call.url)).toEqual(["https://feeds.example.com/choices"]);
  });

  it("and gives a redirect status without a location, or a 304, as the answer", async () => {
    const { fetch, calls } = throughNode((url) =>
      url.endsWith("/moved") ? new Response("no location", { status: 301 }) : new Response(null, { status: 304, headers: { etag: '"abc"' } }),
    );
    expect(await fetch("https://feeds.example.com/moved")).toMatchObject({ status: 301, text: "no location" });
    expect(await fetch(FEED, { headers: { "if-none-match": '"abc"' } })).toMatchObject({
      status: 304,
      ok: false,
      headers: { etag: '"abc"' },
    });
    expect(calls).toHaveLength(2);
  });
});

describe("ctx.fetch's limits", () => {
  it("give up after 20 seconds without an answer, aborting the request", async () => {
    const { fetch, fake, calls } = throughNode(() => "never");
    const call = watch(fetch(SEARCH));
    await fake.advance(ANSWER_TIME_LIMIT_MS - 1);
    expect(call.settled).toBe(false);
    expect(calls[0]?.init.signal?.aborted).toBe(false);
    await fake.advance(1);
    expect(await failure(call.promise)).toMatchObject({
      code: "timeout",
      message: `No whole answer within 20 seconds: ${SEARCH}`,
    });
    expect(calls[0]?.init.signal?.aborted).toBe(true);
  });

  it("give up after 20 seconds also on a transport that does not listen to its signal", async () => {
    const { fetch, fake } = setUp({ transport: () => new Promise<Response>(() => {}) });
    const call = watch(fetch(SEARCH));
    await fake.advance(ANSWER_TIME_LIMIT_MS);
    expect(await failure(call.promise)).toMatchObject({ code: "timeout" });
  });

  it("cancel an answer that such a transport still gives after the 20 seconds, unread", async () => {
    let read = false;
    let cancelled = false;
    const fake = fakeClock();
    // Read only when asked for: nothing pulls it ahead of a reader.
    const late = () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              read = true;
              controller.enqueue(bytes("too late"));
              controller.close();
            },
            cancel: () => void (cancelled = true),
          },
          { highWaterMark: 0 },
        ),
      );
    const outbound: Outbound = {
      // Deaf to its signal: the answer comes 5 seconds after the limit all the same.
      transport: () => new Promise((resolve) => fake.clock.after(ANSWER_TIME_LIMIT_MS + 5_000, () => resolve(late()))),
      pace: null,
      clock: fake.clock,
    };
    const call = watch(fetchFor(outbound, { hosts: HOSTS, signal: new AbortController().signal })(SEARCH));
    await fake.advance(ANSWER_TIME_LIMIT_MS);
    expect(await failure(call.promise)).toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(false);
    await fake.advance(5_000);
    expect(cancelled).toBe(true);
    expect(read).toBe(false);
  });

  it("count the body in the 20 seconds, and stop a body that stalls", async () => {
    let stopped = false;
    const { fetch, fake } = throughNode(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(bytes('{"items":[')),
            cancel: () => void (stopped = true),
          }),
        ),
    );
    const call = watch(fetch(SEARCH));
    await fake.advance(ANSWER_TIME_LIMIT_MS);
    expect(await failure(call.promise)).toMatchObject({ code: "timeout" });
    expect(stopped).toBe(true);
  });

  it("take an answer that is whole just within the 20 seconds", async () => {
    const fake = fakeClock();
    const outbound: Outbound = {
      transport: () => new Promise((resolve) => fake.clock.after(ANSWER_TIME_LIMIT_MS - 1, () => resolve(new Response("just in time")))),
      pace: null,
      clock: fake.clock,
    };
    const call = watch(fetchFor(outbound, { hosts: HOSTS, signal: new AbortController().signal })(SEARCH));
    await fake.advance(ANSWER_TIME_LIMIT_MS);
    expect((await call.promise).text).toBe("just in time");
  });

  it("take a body of exactly 2 MiB", async () => {
    const { fetch } = throughNode(() => new Response(new Uint8Array(MAX_BODY_BYTES).fill(0x61)));
    const answer = await fetch(FEED);
    expect(answer.text).toHaveLength(MAX_BODY_BYTES);
  });

  it("stop a download that grows past 2 MiB", async () => {
    // Twice the limit is on offer; only a little more than the limit may be taken.
    const CHUNK = 64 * 1024;
    let pulled = 0;
    let stopped = false;
    const { fetch, calls } = throughNode(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                if (pulled >= 2 * MAX_BODY_BYTES) return controller.close();
                pulled += CHUNK;
                controller.enqueue(new Uint8Array(CHUNK).fill(0x61));
              },
              cancel: () => void (stopped = true),
            },
            { highWaterMark: 0 },
          ),
        ),
    );
    expect(await failure(fetch(FEED))).toMatchObject({
      code: "too_large",
      message: `The answer is larger than 2 MiB, so its download was stopped: ${FEED}`,
    });
    expect(stopped).toBe(true);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    expect(pulled).toBeGreaterThan(MAX_BODY_BYTES);
    expect(pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + 2 * CHUNK);
  });

  it("fail as network when no connection can be made, and say why", async () => {
    const { fetch } = throughNode(() =>
      Promise.reject(new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") })),
    );
    expect(await failure(fetch(SEARCH))).toMatchObject({
      code: "network",
      message: "Could not reach api.github.com (getaddrinfo ENOTFOUND api.github.com).",
    });
  });

  it("fail as network when a transport gives something else than an answer, or a body of something else than bytes", async () => {
    const nothing = setUp({ transport: async () => undefined as unknown as Response });
    expect(await failure(nothing.fetch(SEARCH))).toMatchObject({
      code: "network",
      message: "Could not reach api.github.com: the transport gave no answer.",
    });
    const words = throughNode(
      () =>
        new Response(
          new ReadableStream<unknown>({
            start(controller) {
              controller.enqueue("not bytes");
              controller.close();
            },
          }) as ReadableStream<Uint8Array>,
        ),
    );
    expect(await failure(words.fetch(SEARCH))).toMatchObject({
      code: "network",
      message: `The answer from ${SEARCH} is not made of bytes.`,
    });
  });

  it("fail as network when the answer breaks off", async () => {
    const { fetch } = throughNode(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes('{"items":['));
              controller.error(new Error("other side closed"));
            },
          }),
        ),
    );
    expect(await failure(fetch(SEARCH))).toMatchObject({
      code: "network",
      message: `The answer from ${SEARCH} broke off (other side closed).`,
    });
  });
});

describe("ctx.fetch once the run is over", () => {
  it("rejects at once with stopped, and sends nothing", async () => {
    const { fetch, run, requests } = setUp();
    run.abort();
    expect(await failure(fetch(SEARCH))).toMatchObject({
      code: "stopped",
      message: "The run is over: ctx.fetch works only while its job runs.",
    });
    // Even a request that breaks the rules: there is nothing to check it for.
    expect(await failure(fetch("http://example.com/"))).toMatchObject({ code: "stopped" });
    expect(requests).toEqual([]);
  });

  it("gives up a request on its way, and aborts it", async () => {
    const { fetch, run, calls, fake } = throughNode(() => "never");
    const call = watch(fetch(SEARCH));
    await fake.advance(1000);
    run.abort();
    expect(await failure(call.promise)).toMatchObject({
      code: "stopped",
      message: `The run is over, so ctx.fetch gave up on ${SEARCH}.`,
    });
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    expect(fake.pending()).toBe(0);
  });

  it("gives up reading a body, and stops its download", async () => {
    let stopped = false;
    const { fetch, run, fake } = throughNode(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.enqueue(bytes("[")),
            cancel: () => void (stopped = true),
          }),
        ),
    );
    const call = watch(fetch(FEED));
    await fake.advance(1000);
    run.abort();
    expect(await failure(call.promise)).toMatchObject({ code: "stopped" });
    expect(stopped).toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * The pace
 * ---------------------------------------------------------------------- */

describe("the pace", () => {
  /** Two runs, of any apps, behind one pace; what reached the transport, and when. */
  function twoRuns(answer: (request: TransportRequest) => Promise<Response> = async () => new Response("ok")) {
    const fake = fakeClock();
    const starts: [string, number][] = [];
    const outbound: Outbound = {
      transport: (request) => {
        starts.push([request.url, fake.clock.now()]);
        return answer(request);
      },
      pace: createPace(fake.clock),
      clock: fake.clock,
    };
    const first = new AbortController();
    const second = new AbortController();
    return {
      fake,
      starts,
      first,
      fetchFirst: fetchFor(outbound, { hosts: HOSTS, signal: first.signal }),
      fetchSecond: fetchFor(outbound, { hosts: HOSTS, signal: second.signal }),
    };
  }

  it("starts requests to one host 6.5 seconds apart, in the order asked, whichever run asks", async () => {
    const { fake, starts, fetchFirst, fetchSecond } = twoRuns();
    const calls = [fetchFirst(`${SEARCH}?n=1`), fetchSecond(`${SEARCH}?n=2`), fetchFirst(`${SEARCH}?n=3`)].map(watch);
    await fake.advance(PACE_MS - 1);
    expect(starts).toEqual([[`${SEARCH}?n=1`, 0]]);
    await fake.advance(2 * PACE_MS);
    expect(starts).toEqual([
      [`${SEARCH}?n=1`, 0],
      [`${SEARCH}?n=2`, PACE_MS],
      [`${SEARCH}?n=3`, 2 * PACE_MS],
    ]);
    await Promise.all(calls.map((call) => call.promise));
    expect(PACE_MS).toBe(6_500);
  });

  it("holds up no request to another host", async () => {
    const { fake, starts, fetchFirst, fetchSecond } = twoRuns();
    const calls = [fetchFirst(`${SEARCH}?n=1`), fetchSecond(FEED), fetchFirst(`${SEARCH}?n=2`)].map(watch);
    await fake.advance(PACE_MS);
    expect(starts).toEqual([
      [`${SEARCH}?n=1`, 0],
      [FEED, 0],
      [`${SEARCH}?n=2`, PACE_MS],
    ]);
    await Promise.all(calls.map((call) => call.promise));
  });

  it("paces the next request of a redirect too", async () => {
    const { fake, starts, fetchFirst } = twoRuns(async (request) =>
      request.url.endsWith("/old")
        ? new Response(null, { status: 301, headers: { location: "/new" } })
        : new Response("here"),
    );
    const call = watch(fetchFirst("https://feeds.example.com/old"));
    await fake.advance(PACE_MS);
    expect(starts).toEqual([
      ["https://feeds.example.com/old", 0],
      ["https://feeds.example.com/new", PACE_MS],
    ]);
    expect((await call.promise).text).toBe("here");
  });

  it("counts the wait for a turn against the run, not against the 20 seconds of the answer", async () => {
    const twenty = ANSWER_TIME_LIMIT_MS;
    const { fake, fetchFirst } = twoRuns((request) =>
      request.url.endsWith("n=2")
        ? new Promise((resolve) => fake.clock.after(twenty - 5_000, () => resolve(new Response("late, but whole"))))
        : Promise.resolve(new Response("at once")),
    );
    const one = watch(fetchFirst(`${SEARCH}?n=1`));
    const two = watch(fetchFirst(`${SEARCH}?n=2`));
    await fake.advance(PACE_MS + twenty - 5_000);
    expect((await one.promise).text).toBe("at once");
    expect((await two.promise).text).toBe("late, but whole");
  });

  it("lets a request whose run is over leave the line, holding up no one behind it", async () => {
    const { fake, starts, first, fetchFirst, fetchSecond } = twoRuns();
    const one = watch(fetchFirst(`${SEARCH}?n=1`));
    const two = watch(fetchFirst(`${SEARCH}?n=2`));
    const three = watch(fetchSecond(`${SEARCH}?n=3`));
    await fake.advance(1000);
    first.abort();
    expect(await failure(two.promise)).toMatchObject({
      code: "stopped",
      message: `The run is over, so ctx.fetch gave up on ${SEARCH}.`,
    });
    await fake.advance(PACE_MS - 1000);
    expect(starts).toEqual([
      [`${SEARCH}?n=1`, 0],
      [`${SEARCH}?n=3`, PACE_MS],
    ]);
    await one.promise;
    await three.promise;
  });
});

/* -------------------------------------------------------------------------
 * The stand-in file
 * ---------------------------------------------------------------------- */

describe("the stand-in file", () => {
  const folder = mkdtempSync(join(tmpdir(), "hearth-standins-"));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  let files = 0;

  /** Writes the file whole, by renaming a new one into place, as a test must. */
  function write(path: string, content: unknown): void {
    const next = `${path}.next`;
    writeFileSync(next, typeof content === "string" ? content : JSON.stringify(content));
    renameSync(next, path);
  }
  function standIns(content: unknown): string {
    const path = join(folder, `standins-${(files += 1)}.json`);
    write(path, content);
    return path;
  }
  /** ctx.fetch for a run of a server whose HEARTH_FETCH_STANDINS names `path`. */
  function fetchFrom(path: string) {
    const fake = fakeClock();
    const outbound = outboundFor({ fetchStandIns: path }, fake.clock);
    return { fetch: fetchFor(outbound, { hosts: HOSTS, signal: new AbortController().signal }), outbound, fake };
  }

  it("answers from the first entry whose address is the request's, and each of whose query texts is part of that parameter", async () => {
    const { fetch } = fetchFrom(
      standIns([
        { url: SEARCH, query: { q: "language:rust" }, status: 403, body: { message: "API rate limit exceeded" } },
        { url: SEARCH, query: { q: "created:>=", per_page: "25" }, body: { items: [{ id: 1 }] } },
        { url: FEED, headers: { "content-type": "text/plain", "x-from": "stand-in" }, body: "plain text, sent as is" },
      ]),
    );
    const rust = await fetch(`${SEARCH}?q=created%3A%3E%3D2026-11-11+language%3Arust&sort=stars&per_page=25`);
    expect(rust).toMatchObject({ status: 403, ok: false, headers: { "content-type": "application/json" } });
    expect(rust.json()).toEqual({ message: "API rate limit exceeded" });

    const every = await fetch(`${SEARCH}?q=created%3A%3E%3D2026-11-11+fork%3Afalse&sort=stars&per_page=25`);
    expect(every).toMatchObject({ status: 200, ok: true });
    expect(every.json()).toEqual({ items: [{ id: 1 }] });

    const feed = await fetch(`${FEED}?since=yesterday`);
    expect(feed).toMatchObject({ status: 200, text: "plain text, sent as is" });
    expect(feed.headers).toMatchObject({ "content-type": "text/plain", "x-from": "stand-in" });

    // per_page is missing, and with it the second entry's match.
    expect(await failure(fetch(`${SEARCH}?q=created%3A%3E%3D2026-11-11`))).toMatchObject({
      code: "network",
      message: `No stand-in answers ${SEARCH}?q=created%3A%3E%3D2026-11-11.`,
    });
    expect(await failure(fetch("https://api.github.com/search/users"))).toMatchObject({ code: "network" });
  });

  it("fails with an entry's error at once, as the network would", async () => {
    const { fetch, fake } = fetchFrom(
      standIns([
        { url: "https://feeds.example.com/down", error: "network" },
        { url: "https://feeds.example.com/slow", error: "timeout" },
      ]),
    );
    expect(await failure(fetch("https://feeds.example.com/down"))).toMatchObject({
      code: "network",
      message: "Could not reach feeds.example.com (a stand-in's error).",
    });
    expect(await failure(fetch("https://feeds.example.com/slow"))).toMatchObject({
      code: "timeout",
      message: "No whole answer within 20 seconds (a stand-in's error): https://feeds.example.com/slow",
    });
    expect(fake.pending()).toBe(0);
  });

  it("is read again at every request, so that a test changes the answers by writing it", async () => {
    const path = standIns([{ url: FEED, body: { headlines: ["first"] } }]);
    const { fetch } = fetchFrom(path);
    expect((await fetch(FEED)).json()).toEqual({ headlines: ["first"] });
    write(path, [{ url: FEED, body: { headlines: ["second"] } }]);
    expect((await fetch(FEED)).json()).toEqual({ headlines: ["second"] });
    write(path, [{ url: FEED, error: "network" }]);
    expect(await failure(fetch(FEED))).toMatchObject({ code: "network" });
  });

  it.each([
    ["missing", null, "cannot be read"],
    ["not JSON", "{ nope", "is not valid JSON."],
    ["not a list", { url: FEED }, "is not a list of stand-ins: "],
    ["an address with a query", [{ url: `${FEED}?x=1` }], "0.url: must be an https address without a query or fragment"],
    ["an http address", [{ url: "http://feeds.example.com/x" }], "0.url: must be an https address"],
    ["a status no answer has", [{ url: FEED, status: 99 }], "0.status"],
    ["a key it does not know", [{ url: FEED, stauts: 500 }], 'Unrecognized key: "stauts"'],
    ["an error beside an answer", [{ url: FEED, error: "network", status: 500 }], "0.error: An entry either fails with error or answers"],
    ["an error it does not know", [{ url: FEED, error: "refused" }], "0.error"],
    ["a body where the status has none", [{ url: FEED, status: 204, body: "x" }], "0.body: An answer with status 204 has no body."],
    ["a header HTTP does not allow", [{ url: FEED, headers: { "bad name": "x" } }], "0.headers: Holds a name or a value"],
  ])("fails every request as network while the file is %s, saying so", async (_label, content, words) => {
    const path = content === null ? join(folder, "missing.json") : standIns(content);
    const { fetch } = fetchFrom(path);
    const error = await failure(fetch(FEED));
    expect(error.code).toBe("network");
    expect(error.message).toContain(`The stand-in file ${path}`);
    expect(error.message).toContain(words);
  });

  it("comes after the rules: no stand-in opens what the rules refuse", async () => {
    const { fetch } = fetchFrom(
      standIns([
        { url: "https://example.com/", body: "should never be seen" },
        { url: FEED, body: "headlines" },
      ]),
    );
    expect(await failure(fetch("https://example.com/"))).toMatchObject({ code: "refused" });
    expect(await failure(fetch(FEED, { headers: { cookie: "session=1" } }))).toMatchObject({ code: "refused" });
  });

  it("may answer with a redirect, which the rules follow on the same host", async () => {
    const { fetch } = fetchFrom(
      standIns([
        { url: "https://feeds.example.com/old", status: 301, headers: { location: "/new" } },
        { url: "https://feeds.example.com/new", body: "moved here" },
        { url: "https://feeds.example.com/away", status: 302, headers: { location: SEARCH } },
      ]),
    );
    expect(await fetch("https://feeds.example.com/old")).toMatchObject({
      url: "https://feeds.example.com/new",
      text: "moved here",
    });
    expect(await failure(fetch("https://feeds.example.com/away"))).toMatchObject({ code: "refused" });
  });

  it("answers at once: stand-ins are not paced", async () => {
    const { fetch, outbound, fake } = fetchFrom(standIns([{ url: SEARCH, body: { items: [] } }]));
    expect(outbound.pace).toBeNull();
    const answers = await Promise.all([fetch(SEARCH), fetch(SEARCH), fetch(SEARCH)]);
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    expect(fake.pending()).toBe(0);
  });
});

describe("outboundFor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes Node's own fetch, paced, unless the settings name stand-ins", async () => {
    const { fetchFunction, calls } = madeUpFetch(() => new Response("from the made-up fetch"));
    vi.stubGlobal("fetch", fetchFunction);
    const fake = fakeClock();
    const outbound = outboundFor({ fetchStandIns: null }, fake.clock);
    expect(outbound.pace).not.toBeNull();
    const fetch = fetchFor(outbound, { hosts: HOSTS, signal: new AbortController().signal });
    const one = watch(fetch(SEARCH));
    const two = watch(fetch(SEARCH));
    await fake.advance(PACE_MS - 1);
    expect(calls).toHaveLength(1);
    await fake.advance(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
    expect((await one.promise).text).toBe("from the made-up fetch");
    await two.promise;
  });
});
