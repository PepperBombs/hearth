import { Link, useParams } from "react-router";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, EmptyState, buttonClass } from "../components/ui";
import { pickLocalized } from "../i18n";
import { useI18n } from "../session/preferences";
import { enabledApps, useSession } from "../session/session";
import { NotFound } from "./not-found";

/**
 * The address an app's own page will live at. Mini-apps cannot be loaded yet,
 * so for now this says so; it exists so that links from the sidebar, the app
 * list and the quick switcher already have somewhere to go.
 */
export function AppPage() {
  const { spaceId, appId } = useParams();
  const session = useSession();
  const { locale, t } = useI18n();
  const app = enabledApps(session).find((candidate) => candidate.spaceId === spaceId && candidate.id === appId);
  if (!app || !app.hasPage) return <NotFound />;

  return (
    <Page title={pickLocalized(app.name, locale)}>
      <Card className="min-h-[320px] max-w-[760px] justify-center">
        <EmptyState
          icon={<AppIcon icon={app.icon} color={app.color} size={20} />}
          title={t("appPage.unavailableTitle")}
          action={
            <Link to="/apps" className={buttonClass()}>
              {t("appPage.back")}
            </Link>
          }
        >
          {t("appPage.unavailableBody")}
        </EmptyState>
      </Card>
    </Page>
  );
}
