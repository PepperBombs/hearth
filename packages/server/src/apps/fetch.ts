/**
 * `ctx.fetch`: the one way out to the network a mini-app is written to use,
 * from a job.
 *
 * A request goes through three parts, each given to the next, so that the
 * rules are tested without a network:
 *
 * 1. The rules (`fetchFor`), at every request. GET only, to https on the
 *    default port, without a user name or password, to a host the app's
 *    manifest lists in `network`, exactly. `User-Agent: Hearth` and the few
 *    headers a job may add, nothing else: a job has no person's request
 *    behind it, so nothing of a person's goes out, and no cookie is kept.
 *    Redirects are followed up to 3 times while they stay on https and the
 *    same host. An answer takes at most 20 seconds and 2 MiB of body,
 *    counted after decompression. Anything else rejects with a FetchError
 *    whose code says why.
 * 2. The pace (`createPace`): requests to one host start at least 6.5
 *    seconds apart, across every app, install and job of the server, so at
 *    most 10 a minute, GitHub's unauthenticated search limit (owner's
 *    decision 12). Stand-ins answer at once and are not paced.
 * 3. The transport: one request, one answer, no redirect followed. Node's
 *    own fetch on a server (`nodeTransport`), the stand-in file named by
 *    HEARTH_FETCH_STANDINS in end-to-end tests (`standInFile`), a test's own
 *    function in an app's tests.
 *
 * `outboundFor` picks the transport and the pace from the server's settings;
 * one of them serves the whole server. A run of a job gets its `ctx.fetch`
 * from `fetchFor`, with the hosts of its app and a signal that ends with the
 * run.
 *
 * It is not a sandbox. A mini-app is trusted code that could find another
 * way out at run time; ESLint and the import scan refuse the global `fetch`
 * and every package in a mini-app, so that this is the way apps are
 * written to use.
 *
 * Design: docs/mini-app-contract.md, section C ("ctx.fetch" and
 * "Switches"), and the owner's decisions 12 and 14.
 */
import { readFile } from "node:fs/promises";
import { FetchError, type FetchInit, type FetchResponse } from "@hearth/sdk/server";
import { z } from "zod";
import type { Config } from "../config";

/** What every request says it comes from. */
export const USER_AGENT = "Hearth";
/** How long an answer may take, from sending its request to the last byte of its body. */
export const ANSWER_TIME_LIMIT_MS = 20_000;
/** The most body an answer may have, counted after decompression. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** How many redirects one `ctx.fetch` follows. */
export const MAX_REDIRECTS = 3;
/**
 * The least time between the starts of two requests to one host, across the
 * whole server: at most 10 a minute, which is what GitHub allows one address
 * for searches without a token.
 */
export const PACE_MS = 6_500;

/** The headers a job may send, besides names starting with "x-" (see mayBeSent). */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "accept-language",
  "if-modified-since",
  "if-none-match",
]);
/** The statuses fetch follows as redirects. Any other 3xx, such as 304, is an answer. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Statuses whose answer has no body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
/** Headers of an answer that a job never sees: no cookie is kept, nor handed over to be sent back. */
const HIDDEN_ANSWER_HEADERS: ReadonlySet<string> = new Set(["set-cookie", "set-cookie2"]);
/** An HTTP header name: a "token". */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** A header value a job may send: visible ASCII, spaces and tabs, so no line break and nothing read two ways. */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

/** A request that passed the rules, as a transport gets it. */
export type TransportRequest = {
  /** An https address on a host the app's manifest lists, with no user name, password, port or fragment. */
  readonly url: string;
  /** Every header to send, names in lower case: `user-agent`, and those the job added. */
  readonly headers: Readonly<Record<string, string>>;
  /** Aborted when the answer has taken too long, the run is over or the body grew too large: give up then. */
  readonly signal: AbortSignal;
};

/**
 * Makes one request and gives its answer as it arrives, without following a
 * redirect. It rejects when there is no answer: a FetchError with the code
 * "timeout" or "network" says which, and any other rejection counts as
 * "network". The rules do not wait for one that ignores its signal.
 */
export type Transport = (request: TransportRequest) => Promise<Response>;

/** Time as the pace and the time limit read it: given, so that tests need not wait. */
export type Clock = {
  /** Milliseconds from a fixed moment, never going back. Only differences are used. */
  now(): number;
  /** Calls `then` once `ms` milliseconds have passed. The function it returns cancels that. */
  after(ms: number, then: () => void): () => void;
};

/** The process's own clock: monotonic, so that setting the system's time neither stretches nor skips a wait. */
export const processClock: Clock = {
  now: () => performance.now(),
  after(ms, then) {
    const timer = setTimeout(then, ms);
    return () => clearTimeout(timer);
  },
};

/** Keeps requests to one host apart. */
export type Pace = {
  /**
   * Resolves when a request to `host` may start, and counts it as started.
   * Rejects, and leaves the line, when `signal` aborts first.
   */
  turn(host: string, signal: AbortSignal): Promise<void>;
};

/** The way out of a server: one transport, and for real hosts one pace for all of it. */
export type Outbound = {
  readonly transport: Transport;
  /** Null when the transport answers without a network, as stand-ins do: they are not paced. */
  readonly pace: Pace | null;
  readonly clock: Clock;
};

/** What `ctx.fetch` needs from the run it serves. */
export type FetchScope = {
  /** The hosts the app's manifest lists in `network`: the only ones it may reach. */
  readonly hosts: readonly string[];
  /** Aborts when the run is over. From then on, and for a request still on its way, ctx.fetch rejects with "stopped". */
  readonly signal: AbortSignal;
};

/** What Node's fetch is called with. A test gives a made-up one that returns real Response objects. */
export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

/** A stand-in's answer: status 200 unless given; a body sent as is when it is text, and as JSON otherwise. */
export type StandInAnswer = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
};

/* -------------------------------------------------------------------------
 * The rules
 * ---------------------------------------------------------------------- */

/**
 * `ctx.fetch` for one run of a job: the rules, then the pace, then the
 * transport. Every argument is checked as it comes, since JavaScript that
 * ignores the SDK's types may pass anything.
 */
export function fetchFor(
  outbound: Outbound,
  scope: FetchScope,
): (url: string, init?: FetchInit) => Promise<FetchResponse> {
  return async (url: unknown, init?: unknown): Promise<FetchResponse> => {
    if (scope.signal.aborted) {
      throw new FetchError("stopped", "The run is over: ctx.fetch works only while its job runs.");
    }
    const first = checkAddress(url, scope.hosts);
    const headers = checkHeaders(init);
    let address = first;
    for (let redirects = 0; ; redirects += 1) {
      const answer = await exchange(outbound, address, headers, scope.signal);
      if (answer.location === null) return toFetchResponse(address, answer);
      if (redirects === MAX_REDIRECTS) {
        throw refused(`${shown(first)} redirects more than ${MAX_REDIRECTS} times.`);
      }
      address = redirectTarget(answer.location, address, first.hostname);
    }
  };
}

/** Whether a job may send this header, named in lower case. */
function mayBeSent(name: string): boolean {
  if (ALLOWED_HEADERS.has(name)) return true;
  return name.startsWith("x-") && !name.startsWith("x-forwarded") && name !== "x-real-ip";
}

const refused = (message: string) => new FetchError("refused", message);
const stopped = (address: URL) =>
  new FetchError("stopped", `The run is over, so ctx.fetch gave up on ${shown(address)}.`);

function checkAddress(url: unknown, hosts: readonly string[]): URL {
  if (typeof url !== "string") {
    throw refused(`ctx.fetch takes its address as text, not ${kindOf(url)}.`);
  }
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    throw refused(`ctx.fetch takes a whole address, such as https://${hosts[0] ?? "api.example.com"}/, and ${JSON.stringify(cut(url, 80))} is not one.`);
  }
  if (address.protocol !== "https:") {
    const scheme = address.protocol.slice(0, -1);
    throw refused(`Only https addresses are fetched, not ${scheme} ones${address.host === "" ? "." : `: ${shown(address)}`}`);
  }
  if (address.username !== "" || address.password !== "") {
    throw refused(`An address may not hold a user name or password: ${shown(address)}`);
  }
  if (address.port !== "") {
    throw refused(`An address may not name a port: ${shown(address)}`);
  }
  if (!hosts.includes(address.hostname)) {
    throw refused(
      hosts.length === 0
        ? `This app's manifest lists no hosts in network, so its jobs fetch from none: ${shown(address)}`
        : `${address.hostname} is not a host this app's manifest lists in network (${hosts.join(", ")}): ${shown(address)}`,
    );
  }
  address.hash = "";
  return address;
}

function checkHeaders(init: unknown): Readonly<Record<string, string>> {
  const headers = new Map<string, string>([["user-agent", USER_AGENT]]);
  if (init !== undefined) {
    if (!isPlainObject(init)) throw refused("ctx.fetch takes { headers } as its second argument, or nothing.");
    for (const key of Object.keys(init)) {
      if (key !== "headers") {
        throw refused(`ctx.fetch takes headers alone, not ${JSON.stringify(cut(key, 40))}: a job only sends GET requests.`);
      }
    }
    const given = init.headers;
    if (given !== undefined) {
      if (!isPlainObject(given)) {
        throw refused('headers must be an object of names and values, such as { accept: "application/json" }.');
      }
      for (const [name, value] of Object.entries(given)) {
        if (!HEADER_NAME.test(name)) throw refused(`${JSON.stringify(cut(name, 40))} is not a header name.`);
        const lower = name.toLowerCase();
        if (!mayBeSent(lower)) {
          throw refused(
            `A job may not send the header ${lower}. It may send accept, accept-language, if-modified-since, if-none-match, and names starting with x- other than x-forwarded-* and x-real-ip.`,
          );
        }
        if (headers.has(lower)) throw refused(`The header ${lower} is given twice.`);
        if (typeof value !== "string" || !HEADER_VALUE.test(value)) {
          throw refused(`The value of the header ${lower} must be text of visible ASCII characters, spaces and tabs.`);
        }
        headers.set(lower, value);
      }
    }
  }
  return Object.freeze(Object.fromEntries(headers));
}

function redirectTarget(location: string, from: URL, host: string): URL {
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    throw refused(`${shown(from)} redirects to an address that is not valid.`);
  }
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    target.port !== "" ||
    target.hostname !== host
  ) {
    throw refused(
      `${shown(from)} redirects to ${shown(target)}, which is not followed: only redirects on https to the same host are.`,
    );
  }
  target.hash = "";
  return target;
}

/** One request and its answer: a redirect to follow, or the answer read whole. */
type Exchanged =
  | { readonly location: string }
  | { readonly location: null; readonly status: number; readonly headers: Headers; readonly body: Uint8Array };

/**
 * Waits for the host's turn, sends one request and reads its answer whole,
 * within the time limit. A transport, or a body, that does not listen to its
 * signal is not waited for: the time limit and the end of the run reject
 * all the same.
 */
async function exchange(
  outbound: Outbound,
  address: URL,
  headers: Readonly<Record<string, string>>,
  stop: AbortSignal,
): Promise<Exchanged> {
  if (outbound.pace !== null) {
    try {
      await outbound.pace.turn(address.hostname, stop);
    } catch {
      throw stopped(address);
    }
  }
  if (stop.aborted) throw stopped(address);

  // Aborted when the time is up, the run is over or the body grew too large.
  const controller = new AbortController();
  const giveUp = (reason: FetchError) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onStop = () => giveUp(stopped(address));
  stop.addEventListener("abort", onStop, { once: true });
  const cancelTimer = outbound.clock.after(ANSWER_TIME_LIMIT_MS, () =>
    giveUp(new FetchError("timeout", `No whole answer within ${ANSWER_TIME_LIMIT_MS / 1000} seconds: ${shown(address)}`)),
  );
  // Settles only by rejecting, with the reason the controller aborted for.
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  aborted.catch(() => {});

  try {
    const sent = (async () => outbound.transport({ url: address.href, headers, signal: controller.signal }))();
    let response: Response;
    try {
      response = await Promise.race([sent, aborted]);
    } catch (error) {
      if (controller.signal.aborted) {
        // An answer that still comes is not read.
        sent.then((late) => late instanceof Response && discard(late), () => {});
        throw controller.signal.reason;
      }
      throw notReached(error, address);
    }
    if (!(response instanceof Response)) {
      throw new FetchError("network", `Could not reach ${address.hostname}: the transport gave no answer.`);
    }
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
    if (location !== null) {
      discard(response);
      return { location };
    }
    const body = await readWhole(response, address, controller.signal, aborted, giveUp);
    return { location: null, status: response.status, headers: response.headers, body };
  } finally {
    cancelTimer();
    stop.removeEventListener("abort", onStop);
  }
}

/** Reads a body to its end, stopping the download once it grows past the limit. */
async function readWhole(
  response: Response,
  address: URL,
  signal: AbortSignal,
  aborted: Promise<never>,
  giveUp: (reason: FetchError) => void,
): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), aborted]);
      if (read.done) break;
      const chunk: unknown = read.value;
      if (!(chunk instanceof Uint8Array)) {
        throw new FetchError("network", `The answer from ${shown(address)} is not made of bytes.`);
      }
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new FetchError("too_large", `The answer is larger than 2 MiB, so its download was stopped: ${shown(address)}`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    const reason: FetchError = signal.aborted
      ? (signal.reason as FetchError)
      : error instanceof FetchError
        ? error
        : new FetchError("network", `The answer from ${shown(address)} broke off${because(error)}`);
    // Stops the download: the transport listens to the signal, a stream to its cancel.
    giveUp(reason);
    reader.cancel(reason).catch(() => {});
    throw reason;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function toFetchResponse(
  address: URL,
  answer: { readonly status: number; readonly headers: Headers; readonly body: Uint8Array },
): FetchResponse {
  const text = new TextDecoder().decode(answer.body);
  const headers: Record<string, string> = Object.fromEntries(
    [...answer.headers].filter(([name]) => !HIDDEN_ANSWER_HEADERS.has(name)),
  );
  return Object.freeze({
    url: address.href,
    status: answer.status,
    ok: answer.status >= 200 && answer.status <= 299,
    headers: Object.freeze(headers),
    text,
    json(): unknown {
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new SyntaxError(`The answer from ${shown(address)} is not JSON${because(error)}`, { cause: error });
      }
    },
  });
}

function notReached(error: unknown, address: URL): FetchError {
  // A transport that knows why there is no answer says so itself, as the stand-ins do.
  if (error instanceof FetchError && (error.code === "network" || error.code === "timeout")) return error;
  return new FetchError("network", `Could not reach ${address.hostname}${because(error)}`);
}

/** Cancels a body nobody will read, so that its connection is let go. */
function discard(response: Response): void {
  response.body?.cancel().catch(() => {});
}

/* -------------------------------------------------------------------------
 * The pace
 * ---------------------------------------------------------------------- */

/**
 * Lets requests to one host start at least `gapMs` apart, in the order they
 * asked, whichever app, install or job asks. One serves the whole server.
 * A request whose run is over leaves the line and holds up no one behind
 * it, so a run that ends with requests still waiting leaves nothing owed.
 */
export function createPace(clock: Clock, gapMs: number = PACE_MS): Pace {
  type Waiter = { readonly go: () => void };
  type Line = { lastStart: number; waiting: Waiter[]; cancelWake: (() => void) | null };
  const lines = new Map<string, Line>();

  function next(line: Line): void {
    if (line.cancelWake !== null || line.waiting.length === 0) return;
    const now = clock.now();
    const wait = line.lastStart + gapMs - now;
    if (wait > 0) {
      line.cancelWake = clock.after(wait, () => {
        line.cancelWake = null;
        next(line);
      });
      return;
    }
    line.lastStart = now;
    line.waiting.shift()?.go();
    next(line);
  }

  return {
    turn(host, signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        let line = lines.get(host);
        if (line === undefined) {
          line = { lastStart: -Infinity, waiting: [], cancelWake: null };
          lines.set(host, line);
        }
        const own = line;
        const leave = () => {
          own.waiting = own.waiting.filter((waiter) => waiter !== self);
          if (own.waiting.length === 0 && own.cancelWake !== null) {
            own.cancelWake();
            own.cancelWake = null;
          }
          reject(signal.reason);
        };
        const self: Waiter = {
          go: () => {
            signal.removeEventListener("abort", leave);
            resolve();
          },
        };
        signal.addEventListener("abort", leave, { once: true });
        own.waiting.push(self);
        next(own);
      });
    },
  };
}

/* -------------------------------------------------------------------------
 * The transports
 * ---------------------------------------------------------------------- */

/**
 * Node's own fetch, as a server uses it: one request with `redirect:
 * "manual"`, which in Node hands back the redirect itself for the rules to
 * judge, and no cookies. It decompresses what it is sent, so the body the
 * rules count is the decompressed one. What it adds of its own
 * (accept-encoding, connection and the like) says nothing about anyone.
 */
export function nodeTransport(fetchFunction: FetchFunction = (url, init) => fetch(url, init)): Transport {
  return ({ url, headers, signal }) =>
    fetchFunction(url, { method: "GET", headers, redirect: "manual", credentials: "omit", signal });
}

/** A stand-in's answer as a transport gives it. Throws, as Response does, for a status outside 200 to 599 or a body where its status has none. */
export function standInResponse(answer: StandInAnswer): Response {
  const headers = new Headers(answer.headers);
  let body: string | null = null;
  if (typeof answer.body === "string") {
    body = answer.body;
  } else if (answer.body !== undefined) {
    body = JSON.stringify(answer.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return new Response(body, { status: answer.status ?? 200, headers });
}

/** Whether a stand-in's `url` is an https address without a query or fragment. */
function isStandInAddress(value: string): boolean {
  if (value.includes("?") || value.includes("#")) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** One entry of the stand-in file: an answer, or a failure, for the requests it matches. */
const standInSchema = z
  .strictObject({
    /** The address without its query: https://api.github.com/search/repositories. */
    url: z.string().refine(isStandInAddress, {
      error: "must be an https address without a query or fragment, such as https://api.github.com/search/repositories",
    }),
    /** Texts that the request's parameters of these names must hold, each somewhere in it. */
    query: z.record(z.string(), z.string()).optional(),
    status: z.number().int().min(200).max(599).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    /** Fails the request as the network would. */
    error: z.enum(["network", "timeout"]).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.error !== undefined && (entry.status !== undefined || entry.headers !== undefined || entry.body !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "An entry either fails with error or answers with status, headers and body.",
      });
    }
    if (entry.status !== undefined && NULL_BODY_STATUSES.has(entry.status) && entry.body !== undefined) {
      ctx.addIssue({ code: "custom", path: ["body"], message: `An answer with status ${entry.status} has no body.` });
    }
    if (entry.headers !== undefined) {
      try {
        new Headers(entry.headers);
      } catch {
        ctx.addIssue({ code: "custom", path: ["headers"], message: "Holds a name or a value that HTTP does not allow." });
      }
    }
  });
const standInsSchema = z.array(standInSchema);
type StandIn = z.output<typeof standInSchema>;

/**
 * The stand-ins named by HEARTH_FETCH_STANDINS: a JSON list, read again at
 * every request, so that an end-to-end test changes the answers by writing
 * the file. Write it whole, by renaming a new file into place, so that no
 * request reads half of it.
 *
 * The first entry whose `url` is the request's address without its query,
 * and each of whose `query` texts is part of that parameter of the request,
 * answers: `status` (200 when left out), `headers` and `body`, sent as is
 * when it is text and as JSON otherwise; or `error`, "network" or "timeout",
 * at once. A request no entry answers fails as "network", and so does every
 * request while the file is missing, cannot be read or is not such a list,
 * with a message that says so. Nothing reaches the network.
 */
export function standInFile(path: string): Transport {
  return async ({ url }) => {
    const address = new URL(url);
    const entry = (await readStandIns(path)).find((candidate) => answers(candidate, address));
    if (entry === undefined) throw new FetchError("network", `No stand-in answers ${cut(url, 160)}.`);
    if (entry.error === "network") {
      throw new FetchError("network", `Could not reach ${address.hostname} (a stand-in's error).`);
    }
    if (entry.error === "timeout") {
      throw new FetchError(
        "timeout",
        `No whole answer within ${ANSWER_TIME_LIMIT_MS / 1000} seconds (a stand-in's error): ${shown(address)}`,
      );
    }
    return standInResponse(entry);
  };
}

async function readStandIns(path: string): Promise<StandIn[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new FetchError("network", `The stand-in file ${path} cannot be read${because(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FetchError("network", `The stand-in file ${path} is not valid JSON.`);
  }
  const parsed = standInsSchema.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue !== undefined && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    throw new FetchError("network", `The stand-in file ${path} is not a list of stand-ins: ${where}${issue?.message ?? ""}`);
  }
  return parsed.data;
}

function answers(entry: StandIn, address: URL): boolean {
  const own = new URL(entry.url);
  if (own.origin !== address.origin || own.pathname !== address.pathname) return false;
  return Object.entries(entry.query ?? {}).every(([name, text]) =>
    address.searchParams.getAll(name).some((value) => value.includes(text)),
  );
}

/**
 * The way out of this server, from its settings: Node's fetch, paced, or
 * the stand-in file that HEARTH_FETCH_STANDINS names, unpaced. A server
 * makes one, so that its pace holds every job of every app to it.
 */
export function outboundFor(config: Pick<Config, "fetchStandIns">, clock: Clock = processClock): Outbound {
  if (config.fetchStandIns !== null) {
    return { transport: standInFile(config.fetchStandIns), pace: null, clock };
  }
  return { transport: nodeTransport(), pace: createPace(clock), clock };
}

/* -------------------------------------------------------------------------
 * Words
 * ---------------------------------------------------------------------- */

/** An address as a message shows it: without user name, password, query or fragment. */
function shown(address: URL): string {
  return cut(address.host === "" ? address.protocol : `${address.protocol}//${address.host}${address.pathname}`, 120);
}

/** The end of a message that gives an error's reason: " (the reason)." or ".". */
function because(error: unknown): string {
  // Node's fetch rejects with "fetch failed" and keeps the reason in `cause`.
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const message = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return message === "" ? "." : ` (${cut(message, 120)}).`;
}

function cut(text: string, length: number): string {
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return `a value of type ${typeof value}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
