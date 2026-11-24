import type { AppSummary } from "@hearth/shared";
import { Tag } from "@hearth/sdk/web";
import { Copy, MessageSquare } from "lucide-react";
import { Link, useParams } from "react-router";
import { AppSettingsButton } from "../apps/manage";
import { PublishButton } from "../center/publish";
import { MadeAppFrame } from "../made/frame";
import { Page } from "../components/shell/page";
import { Card } from "../components/card";
import { pickLocalized } from "../i18n";
import { useI18n } from "../session/preferences";
import { enabledApps, useSession } from "../session/session";
import { NotFound } from "./not-found";

/**
 * An app's own page, at /apps/:spaceId/:appId. The shell draws the top bar,
 * with the app's name and, for an app in a group, the group's as a tag, on
 * phones too, so that apps of the same name in two spaces are never two
 * pages that look alike, and the button for the app's settings; the app's
 * own page, whole, in its sandbox, is everything inside the panel below it.
 * An owner of the app's space who is in a group also finds "Publish…" there
 * (docs/center.md). A copy of a published app says so above the panel, with
 * "Change it in the chat".
 *
 * Whatever follows the app's ID in the address is left to the app, for the
 * day an app has several pages. An app the session does not list, because
 * it is not there for this person or was switched off, has no page.
 */
export function AppPage() {
  const { spaceId, appId } = useParams();
  const session = useSession();
  const { locale } = useI18n();
  const app = enabledApps(session).find((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
  if (!app || !app.hasPage) return <NotFound />;
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);

  return (
    <Page
      title={pickLocalized(app.name, locale)}
      tag={space?.kind === "group" ? <Tag>{space.name}</Tag> : undefined}
      actions={
        <>
          <PublishButton app={app} />
          <AppSettingsButton app={app} />
        </>
      }
    >
      {app.source ? <CopyLine app={app} source={app.source} /> : null}
      <Card className="min-h-[200px] max-w-[760px]" data-app-page={app.id}>
        {/* The app draws its whole page here, in the sandbox, as tall as it is. */}
        <MadeAppFrame app={app} view="page" maxHeight={100_000} />
      </Card>
    </Page>
  );
}

/**
 * Where a copy came from: who published it, to a viewer in that group, or
 * that it is no longer shared. The session names the publisher, not the
 * published app, and the copy may have been renamed since, so the line
 * names who shared it and not what (docs/center.md, step 8).
 */
function CopyLine({ app, source }: { app: AppSummary; source: NonNullable<AppSummary["source"]> }) {
  const { t } = useI18n();
  const said =
    source.listingId === undefined ? t("copy.noLongerShared") : source.by !== undefined ? t("copy.by", { name: source.by }) : t("copy.shared");
  const chat = `/chat?${new URLSearchParams({ space: app.spaceId, app: app.id }).toString()}`;
  return (
    <p className="mb-3 flex max-w-[760px] flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-2" data-copy-line={app.id}>
      <span className="flex min-w-0 items-center gap-1.5">
        <Copy size={14} aria-hidden="true" className="flex-none text-fg-3" />
        <span className="wrap-anywhere">{said}</span>
      </span>
      {app.access === "edit" ? (
        <Link to={chat} className="flex items-center gap-1 font-medium text-accent hover:underline max-md:min-h-11">
          <MessageSquare size={14} aria-hidden="true" />
          {t("center.changeInChat")}
        </Link>
      ) : null}
    </p>
  );
}
