/**
 * The chat (docs/platform.md, "The chat"): the person tells their own model
 * what they want to keep track of, and it makes an app for it in the chosen
 * space, or adds to and changes the rows of an app there. What it did shows
 * in the conversation, and an app it made shows right there, as on the
 * dashboard.
 *
 * The server keeps each conversation, for the person alone, in its space:
 * the space and the open conversation are in the address
 * (`/chat?space=<id>&chat=<id>`), the person's conversations in that space
 * are listed beside it, and the server gives the model what was said
 * before. Leaving the open conversation (another one, a new one, another
 * space, another page) stops a turn that is still running.
 *
 * The page fills the screen: the conversation scrolls by itself, and the box
 * to write in stays at the bottom of it, above the tab bar on a phone. The
 * model's replies are drawn from Markdown (`components/markdown.tsx`, which
 * says what a reply may not do); what the person wrote stays their text.
 *
 * The model deletes nothing by itself (owner's decision 7): it asks, and the
 * conversation shows a card with what would go, which the person confirms
 * or declines (`DeleteRequestCard`). The server keeps where each request
 * stands, so the card shows the answer after a reload and on another device.
 */
import type { AppSummary, ChatEntry, ChatEvent, ChatFailure, ChatSummary, ConfirmationResult, Space } from "@hearth/shared";
import { Button, Dialog, DialogBody, IconButton, Row, Rows, Segmented, buttonClass, chipClass } from "@hearth/sdk/web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppWindow, ArrowUp, CircleAlert, History, MessagesSquare, PencilLine, Plus, Sparkles, Square, SquarePen, Trash2, Undo2 } from "lucide-react";
import {
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { Link, useSearchParams } from "react-router";
import { Card } from "../components/card";
import { Markdown } from "../components/markdown";
import { Page } from "../components/shell/page";
import { setAssistantLevel } from "../groups/api";
import { spaceAppsKey } from "../groups/queries";
import type { PlainMessageKey } from "../i18n";
import { cx } from "../lib/cx";
import { dayGroup, formatListTime, type DayGroup } from "../lib/date";
import { MadeAppFrame, notifyMadeAppChanged } from "../made/frame";
import {
  MODEL_QUERY_KEY,
  answerDeleteRequest,
  deleteChat,
  fetchModelSettings,
  listChats,
  readChat,
  restoreVersion,
  streamChat,
} from "../made/api";
import { ApiRequestError } from "../session/api";
import { useI18n } from "../session/preferences";
import { SESSION_QUERY_KEY, useSession } from "../session/session";

/** What the page shows: the kept entries, and two of its own, which are never kept. */
type Entry = ChatEntry | { kind: "failure"; failure: "network" | "stopped"; detail: string };

/** A thing the model did, as an entry. */
type ActionEntry = Extract<ChatEntry, { kind: "action" }>;

/** The entry an action event is kept as, with all it says. */
const actionEntry = ({ type: _type, ...fields }: Extract<ChatEvent, { type: "action" }>): ActionEntry => ({ kind: "action", ...fields });

const FAILURES: Record<ChatFailure | "network" | "stopped", PlainMessageKey | "chat.failModel"> = {
  no_model: "chat.failNoModel",
  no_key: "chat.failNoKey",
  no_secret: "chat.failNoSecret",
  model_refused_key: "chat.failKey",
  model_failed: "chat.failModel",
  model_declined: "chat.failDeclined",
  too_many_steps: "chat.failSteps",
  assistant_off: "chat.failOff",
  network: "chat.failNetwork",
  stopped: "chat.stopped",
};

const ACTIONS = {
  app_created: "chat.actionAppCreated",
  row_added: "chat.actionRowAdded",
  row_updated: "chat.actionRowUpdated",
} as const;

/** The small icon beside each thing the model did. (A request to delete is a card of its own.) */
const ACTION_ICONS = {
  app_created: AppWindow,
  app_updated: PencilLine,
  app_restored: History,
  row_added: Plus,
  row_updated: PencilLine,
} as const;

/** What a new conversation offers to start from: a click puts one in the box, to send or change. */
const EXAMPLES = ["chat.example1", "chat.example2", "chat.example3", "chat.example4"] as const;

/** The parts of the list of conversations, in the order they come. */
const DAY_GROUPS: ReadonlyArray<[DayGroup, PlainMessageKey]> = [
  ["today", "chat.today"],
  ["yesterday", "chat.yesterday"],
  ["week", "chat.week"],
  ["older", "chat.older"],
];

/** How close to the end of the conversation counts as at its end, for keeping it there as it grows. */
const NEAR_END = 48;

/** Why a message was not taken, or a conversation could not be opened: the server refused before anything was kept. */
type Notice = "gone" | "busy" | "full" | "tooMany";

const NOTICES: Record<Notice, PlainMessageKey> = {
  gone: "chat.gone",
  busy: "chat.busy",
  full: "chat.full",
  tooMany: "chat.tooMany",
};

const chatsQueryKey = (spaceId: string) => ["chats", spaceId] as const;
const chatQueryKey = (chatId: string | undefined) => ["chat", chatId] as const;

/** The address of a conversation, or of a new one in the space. */
function chatSearch(spaceId: string, chatId?: string): URLSearchParams {
  const search = new URLSearchParams({ space: spaceId });
  if (chatId !== undefined) search.set("chat", chatId);
  return search;
}

/** A dropped connection or a server fault is worth one more go; "not found" is not. */
function retryOnce(failures: number, error: unknown): boolean {
  return failures < 1 && error instanceof ApiRequestError && (error.code === "network" || error.status >= 500);
}

/**
 * The entries on screen, and which conversation they are of (`<spaceId>/<chatId>`, the ID left out for a new one).
 * The first `heard` were read when it was opened: they are drawn outside the live region, so that a screen
 * reader announces only what this visit adds, not the whole conversation each time it is opened.
 */
type Shown = { key: string; entries: Entry[]; heard: number };
const NOTHING_SHOWN: Shown = { key: "", entries: [], heard: 0 };

const isGone = (error: unknown) => error instanceof ApiRequestError && error.status === 404;

export function Chat() {
  const session = useSession();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [search, setSearch] = useSearchParams();
  const model = useQuery({ queryKey: MODEL_QUERY_KEY, queryFn: ({ signal }) => fetchModelSettings(signal) });
  const personal = session.spaces.find((candidate) => candidate.kind === "personal");
  // The space of the address, or the personal one when it names none the person is in.
  const space = session.spaces.find((candidate) => candidate.id === search.get("space")) ?? personal ?? session.spaces[0];
  const spaceId = space?.id ?? "";
  const chatId = search.get("chat") || undefined;
  /** Which conversation is open: a new one in a space has no ID yet. */
  const openKey = `${spaceId}/${chatId ?? ""}`;

  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  const [notice, setNotice] = useState<{ key: string; notice: Notice } | null>(null);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState<AbortController | null>(null);
  const turn = useRef<{ key: string; stop: AbortController } | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [deleting, setDeleting] = useState<{ spaceId: string; chat: ChatSummary } | null>(null);
  /** A conversation deleted from the list beside: once its row is gone, focus goes to that list's New conversation. */
  const [refocus, setRefocus] = useState<string | null>(null);
  const side = useRef<HTMLElement>(null);
  /** The page's content, as wide as the main column: whether the list fits beside the conversation. */
  const root = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);
  /** The conversation, which scrolls by itself, and what it holds. */
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  /** Whether the conversation was scrolled to its end, the last time it moved: then it stays there as it grows. */
  const atEnd = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);

  const chats = useQuery({
    queryKey: chatsQueryKey(spaceId),
    queryFn: ({ signal }) => listChats(spaceId, signal),
    enabled: spaceId !== "",
    retry: retryOnce,
  });

  // A conversation is read when it is opened, and not again while it is on screen: the page adds what a turn sends.
  const needsLoad = chatId !== undefined && shown.key !== openKey;
  const loaded = useQuery({
    queryKey: chatQueryKey(chatId),
    queryFn: ({ signal }) => readChat(spaceId, chatId!, signal),
    enabled: needsLoad,
    retry: retryOnce,
    // Read afresh each time it is opened: what was read before may be from the middle of a turn.
    gcTime: 0,
  });
  const entries = shown.key === openKey ? shown.entries : [];
  const heard = shown.key === openKey ? shown.heard : 0;

  const open = (next: URLSearchParams, replace = false) => setSearch(next, { replace });
  const startNew = (replace = false) => {
    // When a new one is open already, what was said in it before it had an ID goes. (Otherwise leaving clears it.)
    if (chatId === undefined) {
      // A turn that has no ID yet stops too, or its "chat" event would open it again.
      turn.current?.stop.abort();
      setShown(NOTHING_SHOWN);
    }
    open(chatSearch(spaceId), replace);
  };

  // A conversation that is gone, or not the person's, opens a new one instead.
  const loadError = needsLoad ? loaded.error : null;
  useEffect(() => {
    if (!isGone(loadError)) return;
    setNotice({ key: `${spaceId}/`, notice: "gone" });
    void queryClient.invalidateQueries({ queryKey: chatsQueryKey(spaceId) });
    setSearch(chatSearch(spaceId), { replace: true });
  }, [loadError, spaceId, queryClient, setSearch]);

  // Leaving the open conversation stops its turn, as leaving the page does, and it is read afresh when opened again.
  useEffect(() => {
    if (turn.current && turn.current.key !== openKey) turn.current.stop.abort();
    setShown((now) => (now.key === openKey ? now : NOTHING_SHOWN));
    // A notice is about the conversation it was shown in: leaving drops it, so it does not come back.
    setNotice((now) => (now && now.key !== openKey ? null : now));
  }, [openKey]);
  // What was read becomes what is shown; a new conversation shows nothing until something is said in it.
  const read = needsLoad && loaded.data?.chat.id === chatId && !loaded.isFetching ? loaded.data : undefined;
  useEffect(() => {
    if (read) setShown({ key: openKey, entries: read.entries, heard: read.entries.length });
  }, [read, openKey]);
  useEffect(() => () => turn.current?.stop.abort(), []);

  // The delete button that had focus went with its row, and the browser left focus on the page itself.
  // (On a phone the dialog gives it back to Conversations, which stays.)
  useEffect(() => {
    if (refocus === null || chats.data?.some((chat) => chat.id === refocus)) return;
    setRefocus(null);
    if (document.activeElement === null || document.activeElement === document.body) {
      side.current?.querySelector<HTMLButtonElement>("button[data-new-conversation]")?.focus();
    }
  }, [refocus, chats.data]);

  // Opening a conversation and each new entry go to the end of the conversation. (Sending adds the person's
  // message, and the dots come with it; a turn ending adds nothing, so it leaves the person where they read.)
  useLayoutEffect(() => {
    const view = scroller.current;
    if (!view) return;
    view.scrollTop = view.scrollHeight;
    atEnd.current = true;
  }, [entries.length, openKey]);
  // What grows later (an app's frame drawn, the box to write in taller) keeps the end in view, unless the person scrolled up.
  useEffect(() => {
    const view = scroller.current;
    if (!view || !content.current) return;
    const keep = new ResizeObserver(() => {
      if (atEnd.current) view.scrollTop = view.scrollHeight;
    });
    keep.observe(view);
    keep.observe(content.current);
    return () => keep.disconnect();
  }, []);
  const onScroll = () => {
    const view = scroller.current;
    if (view) atEnd.current = view.scrollHeight - view.scrollTop - view.clientHeight <= NEAR_END;
  };

  // The box grows with what is written, up to its largest (about 8 lines, in CSS), and then scrolls. It is
  // measured again when its width changes (a phone turned, the list shown beside), since the text then wraps anew.
  const fit = useCallback(() => {
    const box = input.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, []);
  useLayoutEffect(fit, [draft, fit]);
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    let width = box.clientWidth;
    let frame = 0;
    const watch = new ResizeObserver(() => {
      if (box.clientWidth === width) return; // its own height changing is the fit itself
      width = box.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit); // not inside the observer: resizing what it watches would loop
    });
    watch.observe(box);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [fit]);

  const ready = model.data?.hasKey === true && space !== undefined && space.assistant !== "none" && !needsLoad;

  const send = async (text: string) => {
    if (!space || !ready || text.trim() === "" || running) return;
    const sentSpace = space.id;
    const sentChat = chatId;
    // What a new conversation shows before its first message is of a turn that never got its ID: it is not of this one.
    const before = sentChat === undefined ? [] : entries;
    const current = { key: openKey, stop: new AbortController() };
    turn.current = current;
    setShown((now) => ({
      key: openKey,
      entries: [...before, { kind: "user", text }],
      heard: now.key === openKey ? Math.min(now.heard, before.length) : 0,
    }));
    setDraft("");
    setNotice(null);
    setRunning(current.stop);
    const add = (entry: Entry) => setShown((now) => (now.key === current.key ? { ...now, entries: [...now.entries, entry] } : now));
    const onEvent = (event: ChatEvent) => {
      if (current.stop.signal.aborted) return;
      if (event.type === "chat") {
        // The new conversation has its ID: into the address, in place of the new one, and into the list.
        const was = current.key;
        const key = `${sentSpace}/${event.chatId}`;
        current.key = key;
        // In one transition with the address, which the router changes in a transition: re-keyed alone,
        // the entries would leave the screen for a render.
        startTransition(() => {
          setShown((now) => (now.key === was ? { ...now, key } : now));
          open(chatSearch(sentSpace, event.chatId), true);
        });
        void queryClient.invalidateQueries({ queryKey: chatsQueryKey(sentSpace) });
      } else if (event.type === "text") add({ kind: "model", text: event.text });
      else if (event.type === "error") add({ kind: "failure", failure: event.failure, detail: event.detail });
      else if (event.type === "action") {
        add(actionEntry(event));
        // A new app, or a new version of one, comes with the session, and its page is drawn afresh;
        // a changed row goes to every page of its app on screen. A request to delete changes nothing yet.
        if (event.action === "row_added" || event.action === "row_updated") notifyMadeAppChanged(event.appId);
        else if (event.action !== "delete_requested") void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      }
    };
    try {
      await streamChat({ spaceId: sentSpace, ...(sentChat === undefined ? {} : { chatId: sentChat }), message: text }, onEvent, current.stop.signal);
    } catch (error) {
      if (error instanceof ApiRequestError && (error.status === 404 || error.status === 409)) {
        // Refused before anything was kept: the message goes back into the box.
        setShown((now) => (now.key === current.key ? { ...now, entries: before } : now));
        setDraft((typed) => (typed.trim() === "" ? text : typed));
        if (error.status === 404) {
          // The conversation is gone (deleted elsewhere), or the space is no longer the person's.
          setNotice({ key: `${sentSpace}/`, notice: "gone" });
          if (sentChat === undefined) void queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
          else open(chatSearch(sentSpace), true);
        } else {
          const refused: Notice = sentChat === undefined ? "tooMany" : /full/i.test(error.message) ? "full" : "busy";
          setNotice({ key: current.key, notice: refused });
        }
      } else {
        const stopped = error instanceof DOMException && error.name === "AbortError";
        add({ kind: "failure", failure: stopped ? "stopped" : "network", detail: "" });
      }
    } finally {
      if (turn.current === current) turn.current = null;
      setRunning(null);
      void queryClient.invalidateQueries({ queryKey: chatsQueryKey(sentSpace) });
    }
  };

  /** The person answered a request to delete, here: its card shows the answer for the rest of the visit. */
  const settle = (confirmationId: string, result: ConfirmationResult) =>
    setShown((now) => ({
      ...now,
      entries: now.entries.map((entry) =>
        entry.kind === "action" && entry.confirmationId === confirmationId ? { ...entry, status: result.status, deleted: result.deleted } : entry,
      ),
    }));
  /** What a card needs to answer a request: the open conversation, once it has its ID. */
  const where = chatId === undefined ? undefined : { spaceId, chatId, onSettled: settle };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void send(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(draft);
    }
  };

  const shownNotice = notice?.key === openKey ? notice.notice : null;
  /** A new conversation with nothing said in it yet: a greeting and examples in place of the conversation. */
  const empty = chatId === undefined && entries.length === 0;
  const openTitle = chatId === undefined ? undefined : chats.data?.find((chat) => chat.id === chatId)?.title;
  const noModel = model.isSuccess && model.data?.hasKey !== true;
  const off = space !== undefined && space.assistant === "none";
  /**
   * Why the box is off: no model yet, or the assistant off in this space. In a new conversation, in full in place
   * of the examples; in an open one, a line above the box (`compact`), so that the conversation keeps its room.
   */
  const setUpView = (compact: boolean) =>
    noModel || off ? (
      <div className={cx("flex w-full flex-col", compact ? "gap-2" : "gap-3")}>
        {noModel ? (
          compact ? (
            <div className={NOTICE_LINE}>
              <p className="min-w-0 flex-1">{t("chat.noModel")}</p>
              <Link to="/settings" className={buttonClass({ variant: "primary", size: "sm" })}>
                {t("chat.chooseModel")}
              </Link>
            </div>
          ) : (
            <Card className="items-start gap-3 text-left">
              <p>{t("chat.noModel")}</p>
              <Link to="/settings" className={buttonClass({ variant: "primary" })}>
                {t("chat.chooseModel")}
              </Link>
            </Card>
          )
        ) : null}
        {off ? <AllowHere space={space} compact={compact} /> : null}
      </div>
    ) : null;
  const setUp = setUpView(false);

  const switcher =
    session.spaces.length > 1 ? (
      <div className="max-w-full overflow-x-auto">
        <Segmented<string>
          label={t("chat.space")}
          value={spaceId}
          onChange={(next) => open(chatSearch(next))}
          options={session.spaces.map((candidate) => ({
            value: candidate.id,
            label: candidate.kind === "personal" ? t("chat.personal") : candidate.name,
          }))}
        />
      </div>
    ) : null;

  const list = (onPick: () => void, onDelete: (chat: ChatSummary) => void, titled: boolean) => (
    <ChatList
      spaceId={spaceId}
      chats={chats.data}
      failed={chats.isError}
      onRetry={() => void chats.refetch()}
      openId={chatId}
      onPick={onPick}
      onNew={() => {
        onPick();
        startNew();
      }}
      onDelete={onDelete}
      switcher={switcher}
      titled={titled}
    />
  );

  /** Puts an example in the box, with the cursor after it, to send or change: it is not sent by itself. */
  const takeExample = (text: string) => {
    flushSync(() => setDraft(text));
    const box = input.current;
    if (!box) return;
    box.focus();
    box.setSelectionRange(text.length, text.length);
  };

  /** The sides of the conversation and of the box under it: on a phone, clear of the screen's rounded corners. */
  const gutter = "px-6 max-md:pr-[max(16px,env(safe-area-inset-right))] max-md:pl-[max(16px,env(safe-area-inset-left))]";

  return (
    <Page
      title={openTitle ?? t("chat.title")}
      // Where the list is beside it, it names the open conversation; elsewhere the top bar does.
      heading={narrow ? undefined : t("chat.title")}
      fill
      actions={
        // Where the list is not beside the conversation. Like the dashboard's grid, this measures the main
        // column, not the window: the theme has one breakpoint (md), and 768px is the room the list and a
        // readable conversation need side by side.
        <div className="flex items-center gap-1 @min-[768px]/main:hidden">
          <IconButton label={t("chat.conversations")} aria-haspopup="dialog" onClick={() => setListOpen(true)}>
            <MessagesSquare size={20} aria-hidden="true" />
          </IconButton>
          <IconButton label={t("chat.newConversation")} onClick={() => startNew()}>
            <SquarePen size={20} aria-hidden="true" />
          </IconButton>
        </div>
      }
    >
      <div ref={root} className="flex min-h-0 flex-1">
        <aside
          ref={side}
          className="flex w-64 flex-none flex-col overflow-y-auto border-r border-line px-3 py-4 @max-[768px]/main:hidden"
        >
          {list(
            () => {},
            (chat) => setDeleting({ spaceId, chat }),
            false,
          )}
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* A named region the keyboard reaches: the page no longer scrolls as a whole, so the skip link's target does not. */}
          <div
            ref={scroller}
            onScroll={onScroll}
            tabIndex={0}
            role="region"
            aria-label={t("chat.messages")}
            className="min-h-0 flex-1 overflow-y-auto outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--hearth-accent)]"
          >
            {/* Its end clears the fade above the box: the last line is never dimmed. */}
            <div ref={content} className={cx("mx-auto flex min-h-full w-full max-w-[760px] flex-col gap-5 pt-6 pb-6", gutter)}>
              {empty ? (
                <div className="my-auto flex flex-col items-center gap-3 py-6 text-center">
                  <span aria-hidden="true" className="inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-fg">
                    <Sparkles size={20} />
                  </span>
                  <h2 className="text-xl font-semibold text-balance">{t("chat.greeting")}</h2>
                  <p className="max-w-[460px] text-balance text-fg-2">{t("chat.intro")}</p>
                  {/* Beside the conversation, the list holds the switcher; on a phone the list is a dialog, so it is here too. */}
                  {switcher ? <div className="flex max-w-full justify-center @min-[768px]/main:hidden">{switcher}</div> : null}
                  {setUp ? (
                    <div className="mt-2 w-full max-w-[460px]">{setUp}</div>
                  ) : (
                    <div role="group" aria-label={t("chat.examples")} className="mt-2 flex max-w-[560px] flex-wrap justify-center gap-2">
                      {EXAMPLES.map((key) => (
                        <button
                          key={key}
                          type="button"
                          disabled={!ready}
                          onClick={() => takeExample(t(key))}
                          className={chipClass("max-w-full hover:border-accent hover:text-fg disabled:cursor-not-allowed disabled:opacity-55")}
                        >
                          <span className="clip">{t(key)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {/* What was said before this visit, outside the live region: opening a conversation does not read it all aloud. */}
              {heard > 0 ? (
                <div className="flex flex-col gap-5">
                  {entries.slice(0, heard).map((entry, index) => (
                    <EntryView key={index} entry={entry} where={where} />
                  ))}
                </div>
              ) : null}
              {/* Always in the tree, also empty (its margin then cancels the gap): a live region that appears together
                  with its content is not announced, which would lose the first message of each visit. */}
              <div className="flex flex-col gap-5 empty:-mt-5" aria-live="polite">
                {needsLoad && loaded.isPending ? <p className="text-fg-3">{t("chat.loading")}</p> : null}
                {needsLoad && loaded.isError && !isGone(loaded.error) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-down">
                      {t("chat.loadFailed")}
                    </p>
                    <Button size="sm" onClick={() => void loaded.refetch()}>
                      {t("chat.retry")}
                    </Button>
                  </div>
                ) : null}
                {entries.slice(heard).map((entry, index) => (
                  <EntryView key={heard + index} entry={entry} where={where} />
                ))}
                {running ? <Working /> : null}
              </div>
            </div>
          </div>

          <div className={cx("flex-none pt-2 pb-4 max-md:pb-3", gutter)}>
            <div className="relative mx-auto flex w-full max-w-[760px] flex-col gap-2">
              {/* What is scrolled past fades into the box, rather than being cut off right on it. Only over the column, so
                  never over the scrollbar, and clicks and selection go through it. */}
              <div
                aria-hidden="true"
                data-composer-fade=""
                className="pointer-events-none absolute inset-x-0 -top-6 h-6 bg-linear-to-b from-transparent to-canvas"
              />
              {/* In an open conversation, why the box is off, in a line. (A new one says so in its greeting.) */}
              {!empty ? setUpView(true) : null}
              {shownNotice ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p role="alert" className="text-down">
                    {t(NOTICES[shownNotice])}
                  </p>
                  {shownNotice === "full" ? (
                    <Button size="sm" variant="primary" onClick={() => startNew()}>
                      {t("chat.newConversation")}
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <form
                onSubmit={submit}
                className={cx(
                  "flex items-end gap-2 rounded-card border border-line p-1.5 pl-3 shadow-card",
                  "focus-within:border-accent focus-within:shadow-[0_0_0_1px_var(--hearth-accent)]",
                  ready ? "bg-surface" : "bg-surface-2",
                )}
              >
                <textarea
                  ref={input}
                  aria-label={t("chat.placeholder")}
                  placeholder={t("chat.placeholder")}
                  rows={1}
                  value={draft}
                  disabled={!ready}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  className={cx(
                    "max-h-48 min-w-0 flex-1 resize-none self-center overflow-y-auto bg-transparent py-1.5 text-fg outline-none",
                    "placeholder:text-fg-3 disabled:cursor-not-allowed max-md:text-lg",
                  )}
                />
                {running ? (
                  <button
                    type="button"
                    aria-label={t("chat.stop")}
                    title={t("chat.stop")}
                    onClick={() => running.abort()}
                    className={cx(ROUND, "border border-line bg-surface text-fg hover:bg-surface-2")}
                  >
                    <Square size={12} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    aria-label={t("chat.send")}
                    title={t("chat.send")}
                    disabled={!ready || draft.trim() === ""}
                    className={cx(ROUND, "bg-accent text-on-accent hover:opacity-[.92] disabled:cursor-not-allowed disabled:opacity-40")}
                  >
                    <ArrowUp size={18} aria-hidden="true" />
                  </button>
                )}
              </form>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={listOpen} onClose={() => setListOpen(false)} label={t("chat.conversations")}>
        <DialogBody className="max-h-[calc(100dvh-34px)] overflow-y-auto">
          {list(
            () => setListOpen(false),
            (chat) => {
              setListOpen(false);
              setDeleting({ spaceId, chat });
            },
            true,
          )}
          <div className="flex justify-end">
            <Button onClick={() => setListOpen(false)}>{t("chat.close")}</Button>
          </div>
        </DialogBody>
      </Dialog>

      {deleting ? (
        <DeleteDialog
          spaceId={deleting.spaceId}
          chat={deleting.chat}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            setRefocus(deleting.chat.id);
            // Deleting the open conversation starts a new one.
            if (deleting.chat.id === chatId) startNew(true);
          }}
        />
      ) : null}
    </Page>
  );
}

/** The list's breakpoint, as `@min-[768px]/main` in the classes: the room the list and a readable conversation need side by side. */
const LIST_BESIDE = 768;

/** Whether the main column, which `element` spans, is too narrow for the list beside the conversation. */
function useNarrow(element: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const measured = element.current;
    if (!measured) return;
    const measure = () => setNarrow(measured.getBoundingClientRect().width < LIST_BESIDE);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(measured);
    return () => watch.disconnect();
  }, [element]);
  return narrow;
}

/** The round button at the end of the box: Send, or Stop while a turn runs. A 44px target on phones, as the kit's controls are. */
const ROUND = "inline-flex size-8 flex-none items-center justify-center rounded-full max-md:size-11";

/** Three dots where the reply will come, while the model works; still for whoever asked for less motion. */
function Working() {
  const { t } = useI18n();
  return (
    <div className="flex h-6 items-center gap-1 text-fg-3">
      <span className="sr-only">{t("chat.working")}</span>
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          aria-hidden="true"
          className="size-1.5 rounded-full bg-current motion-safe:animate-[hearth-typing_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: `${dot * 0.16}s` }}
        />
      ))}
    </div>
  );
}

type ChatListProps = {
  spaceId: string;
  chats: ChatSummary[] | undefined;
  failed: boolean;
  onRetry: () => void;
  openId: string | undefined;
  /** A conversation was chosen, or a new one asked for. */
  onPick: () => void;
  onNew: () => void;
  onDelete: (chat: ChatSummary) => void;
  /** The space switcher, when the person is in more than one. */
  switcher: ReactNode;
  /** Whether the list shows its name (in the dialog on a phone); beside the conversation it is for screen readers. */
  titled: boolean;
};

/**
 * The person's conversations in the space, the one used last first, under
 * Today, Yesterday, Previous 7 days and Older on the reader's clock, with a
 * way to start a new one. On a screen with a mouse, a row's delete button
 * shows where the pointer or the keyboard is, in the place of the row's time,
 * so that a row without it gives its title the whole width; on a touch
 * screen it always shows, after the time.
 */
function ChatList({ spaceId, chats, failed, onRetry, openId, onPick, onNew, onDelete, switcher, titled }: ChatListProps) {
  const { t, locale } = useI18n();
  const now = new Date();
  const groups = DAY_GROUPS.map(([group, label]) => ({
    group,
    label,
    chats: (chats ?? []).filter((chat) => dayGroup(new Date(chat.updatedAt), now) === group),
  })).filter((part) => part.chats.length > 0);
  return (
    <nav aria-label={t("chat.conversations")} className="flex min-w-0 flex-col gap-3">
      <h2 className={titled ? "text-md font-semibold" : "sr-only"}>{t("chat.conversations")}</h2>
      <Button size="sm" className="justify-start" data-new-conversation="" onClick={onNew}>
        <Plus size={14} aria-hidden="true" />
        {t("chat.newConversation")}
      </Button>
      {switcher}
      {failed && chats === undefined ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-down">
            {t("chat.listFailed")}
          </p>
          <Button size="sm" onClick={onRetry}>
            {t("chat.retry")}
          </Button>
        </div>
      ) : chats === undefined ? (
        <p className="px-2 text-fg-3">{t("chat.loading")}</p>
      ) : chats.length === 0 ? (
        <p className="px-2 text-fg-3">{t("chat.noConversations")}</p>
      ) : (
        groups.map((part) => (
          <div key={part.group} className="flex flex-col gap-0.5">
            <h3 className="px-2 text-xs font-medium text-fg-3">{t(part.label)}</h3>
            <ul className="flex flex-col gap-px">
              {part.chats.map((chat) => (
                <li
                  key={chat.id}
                  className="group relative flex min-w-0 items-center rounded-ctl hover:bg-hover has-[[aria-current=page]]:bg-accent-soft"
                >
                  <Link
                    to={{ pathname: "/chat", search: `?${chatSearch(spaceId, chat.id).toString()}` }}
                    aria-current={chat.id === openId ? "page" : undefined}
                    onClick={onPick}
                    className={cx(
                      "flex min-w-0 flex-1 items-baseline gap-2 rounded-ctl py-1.5 pr-2 pl-2 text-fg-2 hover:text-fg max-md:py-2.5",
                      "aria-[current=page]:font-medium aria-[current=page]:text-accent-fg",
                    )}
                  >
                    <span className="clip min-w-0 flex-1">{chat.title}</span>
                    <time
                      dateTime={chat.updatedAt}
                      className={cx(
                        "num flex-none text-xs font-normal text-fg-3",
                        // With a mouse, the delete button shows in its place; it keeps its width, so the title stays put.
                        "[@media(hover:hover)]:group-hover:invisible [@media(hover:hover)]:group-has-[:focus-visible]:invisible",
                      )}
                    >
                      {formatListTime(new Date(chat.updatedAt), now, locale)}
                    </time>
                  </Link>
                  <button
                    type="button"
                    aria-label={t("chat.delete", { title: chat.title })}
                    title={t("chat.delete", { title: chat.title })}
                    aria-haspopup="dialog"
                    onClick={() => onDelete(chat)}
                    className={cx(
                      "inline-flex size-7 flex-none items-center justify-center rounded-ctl text-fg-3 hover:bg-hover hover:text-fg max-md:size-11",
                      // With a mouse, over the right end of the row, where the time is, and keeping no room of its own.
                      "[@media(hover:hover)]:absolute [@media(hover:hover)]:inset-y-0 [@media(hover:hover)]:right-1 [@media(hover:hover)]:my-auto",
                      // Shown where the pointer or the keyboard is; a touch screen has no hover, so there it is in the row and always shows.
                      "opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 focus-visible:opacity-100",
                      "[@media(hover:none)]:opacity-100",
                    )}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
}

/** Asks before a conversation is deleted. One that is gone already counts as deleted. */
function DeleteDialog({ spaceId, chat, onClose, onDeleted }: { spaceId: string; chat: ChatSummary; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const remove = useMutation({ mutationFn: () => deleteChat(spaceId, chat.id) });
  const confirm = () => {
    remove
      .mutateAsync()
      .catch((error: unknown) => {
        if (!isGone(error)) throw error;
      })
      .then(
        () => {
          queryClient.setQueryData<ChatSummary[]>(chatsQueryKey(spaceId), (list) => list?.filter((candidate) => candidate.id !== chat.id));
          void queryClient.invalidateQueries({ queryKey: chatsQueryKey(spaceId) });
          queryClient.removeQueries({ queryKey: chatQueryKey(chat.id) });
          onDeleted();
        },
        () => {},
      );
  };
  return (
    <Dialog open onClose={onClose} label={t("chat.deleteTitle")}>
      <DialogBody>
        <h2 className="text-md font-semibold">{t("chat.deleteTitle")}</h2>
        <p className="clip font-medium">{chat.title}</p>
        <p className="text-fg-2">{t("chat.deleteBody")}</p>
        {remove.isError && !isGone(remove.error) ? (
          <p role="alert" className="text-xs text-down">
            {t("chat.deleteFailed")}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t("chat.cancel")}</Button>
          <Button variant="primary" disabled={remove.isPending} onClick={confirm}>
            {t("chat.deleteConfirm")}
          </Button>
        </div>
      </DialogBody>
    </Dialog>
  );
}

/** A notice in one line above the box, with its button at the end: wraps to two on a narrow screen. */
const NOTICE_LINE = "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-ctl border border-line bg-surface px-3 py-2 text-sm";

/**
 * The space's assistant is off: its owners may switch it on here, for their own model and everyone's.
 * `compact`: in a line above the box of an open conversation, in place of a card.
 */
function AllowHere({ space, compact = false }: { space: Space; compact?: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "saving" | "failed">("idle");
  const allow = async () => {
    setState("saving");
    try {
      await setAssistantLevel(space.id, "edit");
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setState("idle");
    } catch {
      setState("failed");
    }
  };
  if (compact) {
    return (
      <div className={NOTICE_LINE}>
        <p className="min-w-0 flex-1">{t("chat.assistantOff")}</p>
        {space.role === "owner" ? (
          <Button variant="primary" size="sm" disabled={state === "saving"} onClick={() => void allow()}>
            {t("chat.allowHere")}
          </Button>
        ) : (
          <p className="text-fg-3">{t("chat.askOwner")}</p>
        )}
        {state === "failed" ? (
          <p role="alert" className="basis-full text-down">
            {t("chat.allowFailed")}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <Card className="items-start gap-3">
      <p>{t("chat.assistantOff")}</p>
      {space.role === "owner" ? (
        <Button variant="primary" disabled={state === "saving"} onClick={() => void allow()}>
          {t("chat.allowHere")}
        </Button>
      ) : (
        <p className="text-fg-3">{t("chat.askOwner")}</p>
      )}
      {state === "failed" ? (
        <p role="alert" className="text-down">
          {t("chat.allowFailed")}
        </p>
      ) : null}
    </Card>
  );
}

/** Where an entry is, for a card that answers a request: the conversation, and what to do with the answer. */
type EntryPlace = { spaceId: string; chatId: string; onSettled: (confirmationId: string, result: ConfirmationResult) => void };

function EntryView({ entry, where }: { entry: Entry; where: EntryPlace | undefined }) {
  const { t } = useI18n();
  const session = useSession();
  const app = useMemo(
    () => (entry.kind === "action" ? session.apps.find((candidate) => candidate.id === entry.appId) : undefined),
    [entry, session.apps],
  );
  switch (entry.kind) {
    case "user":
      // The person's own words, as they wrote them: never read as Markdown.
      return (
        <div className="max-w-[85%] self-end rounded-card bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
          <span className="sr-only">{t("chat.you")}: </span>
          {entry.text}
        </div>
      );
    case "model":
      return (
        <div className="min-w-0 self-stretch text-fg">
          <span className="sr-only">{t("chat.model")}: </span>
          <Markdown text={entry.text} />
        </div>
      );
    case "action": {
      if (entry.action === "delete_requested") return <DeleteRequestCard entry={entry} where={where} />;
      const Icon = ACTION_ICONS[entry.action];
      return (
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-2">
            <span aria-hidden="true" className="inline-flex size-6 flex-none items-center justify-center rounded-full bg-accent-soft text-accent-fg">
              <Icon size={14} />
            </span>
            <span className="min-w-0">
              {entry.action === "app_updated"
                ? t("chat.actionAppUpdated", { app: entry.appName, version: entry.version ?? 0 })
                : entry.action === "app_restored"
                  ? t("chat.actionAppRestored", { app: entry.appName, restored: entry.restored ?? 0 })
                  : t(ACTIONS[entry.action], { app: entry.appName })}
            </span>
            {(entry.action === "app_updated" || entry.action === "app_restored") &&
            app &&
            entry.previous !== undefined &&
            entry.version !== undefined ? (
              <Undo app={app} version={entry.previous} made={entry.version} />
            ) : null}
          </p>
          {/* The app it made, drawn as on the dashboard, once the session holds it. */}
          {entry.action === "app_created" && app ? (
            <Card className="p-0">
              <MadeAppFrame app={app} />
            </Card>
          ) : null}
        </div>
      );
    }
    case "failure": {
      const key = FAILURES[entry.failure];
      return (
        <p role="alert" className="flex items-start gap-2 text-down">
          <CircleAlert size={16} aria-hidden="true" className="mt-[3px]" />
          <span className="min-w-0">{key === "chat.failModel" ? t(key, { detail: entry.detail }) : t(key)}</span>
        </p>
      );
    }
  }
}

/** Why an answer to a request to delete was not taken; the request still waits. */
type AnswerProblem = "forbidden" | "conflict" | "gone" | "failed";

const ANSWER_PROBLEMS: Record<AnswerProblem, PlainMessageKey> = {
  forbidden: "chat.deleteRequestForbidden",
  conflict: "chat.deleteRequestConflict",
  gone: "chat.deleteRequestGone",
  failed: "chat.deleteRequestFailed",
};

/**
 * A request of the model's to delete rows of an app (owner's decision 7):
 * what would go, a few words of each of the first rows, and Delete or
 * Cancel. Nothing goes until the person presses Delete, and the server
 * checks again then. Once answered, here or anywhere else, the card says
 * what became of it, and the buttons are gone. After a delete, every page
 * of the app on screen reads its rows again.
 */
function DeleteRequestCard({ entry, where }: { entry: ActionEntry; where: EntryPlace | undefined }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const outcome = useRef<HTMLParagraphElement>(null);
  /** Whether focus was in the card when it was answered: it goes to what the card says now, as the buttons go. */
  const hadFocus = useRef(false);
  const [state, setState] = useState<"idle" | "sending" | AnswerProblem>("idle");
  const preview = entry.preview ?? [];
  const count = entry.count ?? preview.length;
  const more = count - preview.length;
  const status = entry.status ?? "pending";
  const confirmationId = entry.confirmationId;
  const title =
    count === 1 ? t("chat.deleteRequestOne", { app: entry.appName }) : t("chat.deleteRequestMany", { count, app: entry.appName });

  useEffect(() => {
    if (status === "pending" || !hadFocus.current) return;
    hadFocus.current = false;
    outcome.current?.focus();
  }, [status]);

  const answer = async (decision: "confirm" | "decline") => {
    if (!where || confirmationId === undefined || state === "sending") return;
    hadFocus.current = card.current?.contains(document.activeElement) ?? false;
    setState("sending");
    try {
      const result = await answerDeleteRequest(where.spaceId, where.chatId, confirmationId, decision);
      setState("idle");
      where.onSettled(confirmationId, result);
      if (result.status === "confirmed") {
        notifyMadeAppChanged(entry.appId);
        void queryClient.invalidateQueries({ queryKey: spaceAppsKey(where.spaceId) });
      }
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      if (status === 409) {
        // Answered already, perhaps on another device: the conversation, read again, says how.
        const now = await readChat(where.spaceId, where.chatId).then(
          (chat) => chat.entries.find((other) => other.kind === "action" && other.confirmationId === confirmationId),
          () => undefined,
        );
        if (now?.kind === "action" && now.status !== undefined && now.status !== "pending") {
          setState("idle");
          where.onSettled(confirmationId, { status: now.status, deleted: now.deleted ?? 0 });
          return;
        }
      }
      setState(status === 403 ? "forbidden" : status === 409 ? "conflict" : status === 404 ? "gone" : "failed");
    }
  };

  const deleted = entry.deleted ?? 0;
  const said =
    status === "confirmed"
      ? deleted === 0
        ? t("chat.deleteRequestDoneNone")
        : deleted === 1
          ? t("chat.deleteRequestDoneOne")
          : t("chat.deleteRequestDoneMany", { count: deleted })
      : status === "declined"
        ? t("chat.deleteRequestDeclined")
        : status === "expired"
          ? t("chat.deleteRequestExpired")
          : null;
  const sending = state === "sending";
  const problem = state === "idle" || state === "sending" ? null : state;

  return (
    <Card ref={card} role="group" aria-labelledby={titleId} aria-busy={sending || undefined} className="gap-3">
      <p id={titleId} className="flex items-start gap-2 font-medium text-fg">
        <span aria-hidden="true" className="inline-flex size-6 flex-none items-center justify-center rounded-full bg-surface-2 text-down">
          <Trash2 size={14} />
        </span>
        <span className="min-w-0 self-center [overflow-wrap:anywhere]">{title}</span>
      </p>
      {preview.length > 0 ? (
        // What the rows hold, as they are: data, never translated.
        <Rows className="rounded-ctl border border-line px-3">
          {preview.map((text, index) => (
            <Row key={index} className="text-sm text-fg-2">
              {text}
            </Row>
          ))}
        </Rows>
      ) : null}
      {more > 0 ? <p className="text-xs text-fg-3">{t("chat.deleteRequestMore", { count: more })}</p> : null}
      {said !== null ? (
        <p ref={outcome} tabIndex={-1} role="status" className={cx("rounded-ctl text-sm outline-none", status === "confirmed" ? "text-fg-2" : "text-fg-3")}>
          {said}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {problem ? (
            <p role="alert" className="mr-auto basis-full text-sm text-down">
              {t(ANSWER_PROBLEMS[problem])}
            </p>
          ) : null}
          <Button size="sm" disabled={sending || !where} onClick={() => void answer("decline")}>
            {t("chat.deleteRequestCancel")}
          </Button>
          <Button size="sm" variant="danger" disabled={sending || !where} onClick={() => void answer("confirm")}>
            <Trash2 size={14} aria-hidden="true" />
            {t("chat.deleteRequestConfirm")}
          </Button>
        </div>
      )}
    </Card>
  );
}

/**
 * Undoes a change the model made to an app: the version before it comes
 * back into use, as a new version, which the server refuses when an entry
 * written since would not fit it. Offered only while the version in use is
 * still the one the change made (`made`), also in a conversation opened
 * again later.
 */
function Undo({ app, version, made }: { app: AppSummary; version: number; made: number }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "working" | "done" | "conflict" | "failed">("idle");
  const undo = async () => {
    setState("working");
    try {
      await restoreVersion(app.spaceId, app.id, version);
      await queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY });
      setState("done");
    } catch (error) {
      setState(error instanceof ApiRequestError && error.status === 409 ? "conflict" : "failed");
    }
  };
  if (state === "done") return <span className="text-fg-3">{t("chat.undone")}</span>;
  // Another change came since (this person's, or someone else's in a group): undoing to `version` now
  // would take that back too, so this entry no longer offers it. An Undo already done made a newer version too.
  if (app.version !== made) return null;
  return (
    <>
      <Button size="sm" disabled={state === "working"} onClick={() => void undo()}>
        <Undo2 size={14} aria-hidden="true" />
        {t("chat.undo")}
      </Button>
      {state === "conflict" || state === "failed" ? (
        <span role="alert" className="basis-full text-down">
          {t(state === "conflict" ? "chat.undoConflict" : "chat.undoFailed")}
        </span>
      ) : null}
    </>
  );
}

