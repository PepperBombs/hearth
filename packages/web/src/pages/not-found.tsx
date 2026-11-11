import { Compass } from "lucide-react";
import { Link } from "react-router";
import { EmptyState, buttonClass } from "@hearth/sdk/web";
import { Page } from "../components/shell/page";
import { Card } from "../components/card";
import { useI18n } from "../session/preferences";

export function NotFound() {
  const { t } = useI18n();
  return (
    <Page title={t("notFound.title")}>
      <Card className="min-h-[320px] max-w-[760px] justify-center">
        <EmptyState
          icon={<Compass size={20} />}
          title={t("notFound.heading")}
          action={
            <Link to="/" className={buttonClass({ variant: "primary" })}>
              {t("notFound.back")}
            </Link>
          }
        >
          {t("notFound.body")}
        </EmptyState>
      </Card>
    </Page>
  );
}
