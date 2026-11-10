import { TriangleAlert, X } from "lucide-react";
import { usePreferences } from "../../session/preferences";
import { Button, IconButton } from "../ui";

/** Tells the person when a theme or language change did not reach the server, and offers to send it again. */
export function SaveBanner() {
  const { t, saveFailed, retrySave, dismissSaveFailure } = usePreferences();
  return (
    <div role="status" aria-live="polite">
      {saveFailed ? (
        <div className="flex items-center gap-2.5 border-b border-line bg-warn px-6 py-2 text-warn-fg max-md:px-4">
          <TriangleAlert size={16} aria-hidden="true" />
          <span className="min-w-0 flex-1">{t("save.failed")}</span>
          <Button size="sm" onClick={retrySave}>
            {t("save.retry")}
          </Button>
          <IconButton label={t("save.dismiss")} onClick={dismissSaveFailure}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>
      ) : null}
    </div>
  );
}
