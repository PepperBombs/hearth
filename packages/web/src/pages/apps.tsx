import { ChevronRight, LayoutGrid, Pin, UserRound, Users } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { AppSummary } from "@hearth/shared";
import { AppIcon } from "../components/app-icon";
import { Page } from "../components/shell/page";
import { Card, CardHeader, EmptyState, Row, Rows, Tag } from "../components/ui";
import { pickLocalized } from "../i18n";
import { useI18n } from "../session/preferences";
import { appPath, enabledApps, spacesWithApps, useSession } from "../session/session";

export function Apps() {
  const session = useSession();
  const { t } = useI18n();
  const all = enabledApps(session);
  const { personal, groups } = spacesWithApps(session);
  const pinned = all.filter((app) => app.pinned);

  return (
    <Page title={t("apps.title")}>
      <div className="flex max-w-[760px] flex-col gap-4">
        {all.length === 0 ? (
          <Card className="min-h-[320px] justify-center">
            <EmptyState icon={<LayoutGrid size={20} />} title={t("apps.emptyTitle")}>
              {t("apps.emptyBody")}
            </EmptyState>
          </Card>
        ) : (
          <>
            <AppSection
              icon={<Pin size={16} aria-hidden="true" />}
              title={t("apps.pinned")}
              note={t("apps.pinnedNote")}
              apps={pinned}
              empty={t("apps.pinnedEmpty")}
            />
            <AppSection
              icon={<UserRound size={16} aria-hidden="true" />}
              title={t("nav.personal")}
              note={t("apps.onlyYou")}
              apps={personal}
              empty={t("apps.personalEmpty")}
            />
            {groups.map(({ space, apps }) => (
              <AppSection
                key={space.id}
                icon={<Users size={16} aria-hidden="true" />}
                title={space.name}
                note={t("apps.shared")}
                apps={apps}
                empty={t("apps.groupEmpty")}
              />
            ))}
          </>
        )}
      </div>
    </Page>
  );
}

function AppSection(props: { icon: ReactNode; title: string; note: string; apps: AppSummary[]; empty: string }) {
  return (
    <Card>
      <CardHeader icon={props.icon} title={props.title} aside={props.note} />
      {props.apps.length === 0 ? (
        <p className="text-xs text-fg-3">{props.empty}</p>
      ) : (
        <Rows>
          {props.apps.map((app) => (
            <AppRow key={`${app.spaceId}/${app.id}`} app={app} />
          ))}
        </Rows>
      )}
    </Card>
  );
}

function AppRow({ app }: { app: AppSummary }) {
  const { locale, t } = useI18n();
  const text = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="clip font-medium">{pickLocalized(app.name, locale)}</span>
      <span className="clip text-xs text-fg-3">{pickLocalized(app.description, locale)}</span>
    </span>
  );
  if (!app.hasPage) {
    return (
      <Row>
        <AppIcon icon={app.icon} color={app.color} />
        {text}
        <Tag>{t("apps.widgetOnly")}</Tag>
      </Row>
    );
  }
  return (
    <Row>
      <Link to={appPath(app)} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-ctl">
        <AppIcon icon={app.icon} color={app.color} />
        {text}
        <ChevronRight size={16} aria-hidden="true" className="text-fg-3" />
      </Link>
    </Row>
  );
}
