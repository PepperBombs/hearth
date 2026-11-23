import { Tag } from "@hearth/sdk/web";
import { useParams } from "react-router";
import { AppSettingsButton } from "../apps/manage";
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
      actions={<AppSettingsButton app={app} />}
    >
      <Card className="min-h-[200px] max-w-[760px]" data-app-page={app.id}>
        {/* The app draws its whole page here, in the sandbox, as tall as it is. */}
        <MadeAppFrame app={app} view="page" maxHeight={100_000} />
      </Card>
    </Page>
  );
}
