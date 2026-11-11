import { ArrowRight, LayoutDashboard } from "lucide-react";
import { useMemo } from "react";
import { Link } from "react-router";
import type { AppSummary, WidgetSize } from "@hearth/shared";
import { EmptyState, Tag } from "@hearth/sdk/web";
import { AppView } from "../apps/app-view";
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

/**
 * The room a card takes, which its app chose in the manifest: 1x1, 2x1, 1x2
 * or 2x2 cells. Where there are two columns a wide card fills the row; in a
 * single column every card is one cell, as tall as what it holds.
 */
const SIZE: Record<WidgetSize, string> = {
  small: "",
  wide: "col-span-2 @max-[560px]/main:col-span-1",
  tall: "row-span-2 @max-[560px]/main:row-span-1",
  large: "col-span-2 row-span-2 @max-[560px]/main:col-span-1 @max-[560px]/main:row-span-1",
};

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

/**
 * One app's card. The shell draws the frame: icon, name, the space's tag
 * and the link to the app's page. What is inside is the app's own widget.
 */
function AppCard({ app }: { app: AppSummary }) {
  const session = useSession();
  const { locale, t } = useI18n();
  const space = session.spaces.find((candidate) => candidate.id === app.spaceId);
  const name = pickLocalized(app.name, locale);
  return (
    <Card className={SIZE[app.widgetSize]} data-widget={app.id}>
      <CardHeader
        icon={<AppIcon icon={app.icon} color={app.color} />}
        title={name}
        tag={space?.kind === "group" ? <Tag>{space.name}</Tag> : undefined}
      />
      <AppView app={app} part="widget" />
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
