import { ArrowRight, LayoutDashboard } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { AppSummary } from "@hearth/shared";
import { EmptyState, Tag } from "@hearth/sdk/web";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, CardFooter, CardHeader } from "../components/card";
import { pickLocalized } from "../i18n";
import { formatToday } from "../lib/date";
import { useToday } from "../lib/use-today";
import { useI18n } from "../session/preferences";
import { appPath, enabledApps, useSession } from "../session/session";

/**
 * The widget grid: four columns when there is room, two on medium widths,
 * one on phones. It measures the main column (a container named "main"),
 * not the window, so it stays right whether or not the sidebar is showing.
 * 844px is the mockup's 1100px window less the 256px sidebar.
 */
const GRID =
  "grid grid-flow-dense auto-rows-[minmax(200px,auto)] grid-cols-4 gap-[var(--hearth-gap)] " +
  "@max-[844px]/main:grid-cols-2 @max-[560px]/main:auto-rows-auto @max-[560px]/main:grid-cols-1";

export function Dashboard() {
  const session = useSession();
  const { locale, t } = useI18n();
  const apps = enabledApps(session);
  const date = useToday();
  const today = useMemo(() => formatToday(date, locale), [date, locale]);

  return (
    <Page title={t("dashboard.title")} note={<span className="num">{today}</span>}>
      {apps.length === 0 ? (
        <Card className="min-h-[320px] justify-center">
          <EmptyState icon={<LayoutDashboard size={20} />} title={t("dashboard.emptyTitle")}>
            {t("dashboard.emptyBody")}
          </EmptyState>
        </Card>
      ) : (
        <div className={GRID} data-testid="widget-grid">
          {apps.map((app) => (
            <AppCard key={`${app.spaceId}/${app.id}`} app={app} />
          ))}
        </div>
      )}
    </Page>
  );
}

/** Stands in for an app's widget until apps can supply their own. */
function AppCard({ app }: { app: AppSummary }) {
  const session = useSession();
  const { locale, t } = useI18n();
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  const name = pickLocalized(app.name, locale);
  return (
    <Card>
      <CardHeader
        icon={<AppIcon icon={app.icon} color={app.color} />}
        title={name}
        tag={space?.kind === "group" ? <Tag>{space.name}</Tag> : undefined}
      />
      <p className="text-fg-2">{pickLocalized(app.description, locale) || t("dashboard.noDescription")}</p>
      {app.hasPage ? (
        <CardFooter>
          <Link to={appPath(app)} className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
            <span>
              {t("dashboard.open")}
              <span className="sr-only"> {name}</span>
            </span>
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </CardFooter>
      ) : null}
    </Card>
  );
}
