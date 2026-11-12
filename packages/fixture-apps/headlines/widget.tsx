import { useEffect, useState } from "react";
import type { Locale } from "@hearth/sdk";
import { Button, EmptyState, Row, Rows, appHooks } from "@hearth/sdk/web";
import type server from "./server";

const { useApp, useQuery, useJob } = appHooks<typeof server>();

/** How often the widget reads the clock again, so that "Updated N min ago" moves on by itself. */
const TICK_MS = 15_000;
/** Up to this many minutes it says "Updated N min ago"; after that, the time of day. */
const MINUTES_SHOWN = 90;

/**
 * The body of the headlines' card on the dashboard: the headlines the job
 * kept, when they were fetched, and "Refresh now" for whoever may edit.
 *
 * The job (`refresh` in server.ts) runs by itself every hour, once in each
 * space the app is in. `useJob` says how its runs went here: `succeededAt`
 * is when the headlines shown were fetched, `failedAt` when the last run
 * failed (only when it ended after the last that went well), `running` that
 * a run is going on or was asked for, and `canRun` that this person may ask
 * for one. Once a run went well the shell reads the headlines again before
 * it hands over the new time, so they are never older than "Updated ..."
 * says. Why a run failed is not handed over: what a person reads comes from
 * the app's own strings, in their language.
 *
 * The shell draws the card around it, the skeleton until the first answers
 * are there and the failed state when they cannot be had.
 */
export default function Widget() {
  const { t, locale } = useApp();
  const headlines = useQuery("latest");
  const refresh = useJob("refresh");
  const now = useNow();
  const clock = (at: string) => timeOfDay(at, locale);

  const updated = (at: string) => {
    // A time the server's clock put a little ahead of this browser's is "just now".
    const minutes = Math.floor((now - Date.parse(at)) / 60_000);
    if (minutes < 1) return t("updatedNow");
    if (minutes < MINUTES_SHOWN) return t("updatedMinutes", { minutes });
    return t("updatedAt", { time: clock(at) });
  };

  const failure =
    refresh.failedAt === null
      ? null
      : refresh.succeededAt === null
        ? t("failed", { time: clock(refresh.failedAt) })
        : t("failedShowing", { time: clock(refresh.failedAt), previous: clock(refresh.succeededAt) });
  // Before any run went well the first is on its way, unless it failed; after one, the feed had none.
  const empty = refresh.succeededAt !== null ? t("none") : refresh.failedAt !== null ? t("empty") : t("emptyFirst");

  return (
    <div className="flex min-h-[88px] flex-1 flex-col">
      {headlines.length > 0 ? (
        <Rows>
          {headlines.map((headline) => (
            <Row key={headline.id}>{headline.title}</Row>
          ))}
        </Rows>
      ) : (
        <EmptyState level={3} title={empty} className="min-h-[88px] justify-center py-2" />
      )}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-2">
        {refresh.running ? (
          <p className="text-xs text-fg-3">{t("refreshing")}</p>
        ) : failure !== null ? (
          <p role="status" className="rounded-ctl bg-warn px-2.5 py-1.5 text-xs text-warn-fg">
            {failure}
          </p>
        ) : refresh.succeededAt !== null ? (
          <p className="num text-xs text-fg-3">{updated(refresh.succeededAt)}</p>
        ) : null}
        {refresh.canRun ? (
          // A run asked for starts at once, or 5 minutes after the last one started: asking again does no harm.
          <Button size="sm" className="ml-auto" disabled={refresh.running || refresh.pending} onClick={() => void refresh.run()}>
            {t("refresh")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** This browser's clock, read again every TICK_MS while the widget is shown. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** A moment as a time of day on the reader's clock, in their language: "14:05". */
function timeOfDay(at: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}
