/**
 * The parts every dialog that puts an app in a space is made of: the
 * radio buttons, the bordered choice they sit in, and "Who else can use
 * it", "only me for now" first. Adding a built-in app, moving an app and
 * bringing one back (pages/apps.tsx) use them, and so does adding a copy
 * from the app center (pages/center.tsx).
 */
import type { MemberAccess } from "@hearth/shared";
import type { PlainMessageKey } from "../i18n";
import { useI18n } from "../session/preferences";

/** A radio button in a dialog's list of choices. */
export const RADIO = "size-4 flex-none accent-accent";

/** A choice drawn as a bordered box, lit while its radio button is checked. */
export const CHOICE =
  "flex min-w-0 cursor-pointer items-center gap-2.5 rounded-ctl border border-line px-2.5 py-2 has-checked:border-accent has-checked:bg-accent-soft";

const ACCESS_CHOICES: ReadonlyArray<{ value: MemberAccess; label: PlainMessageKey }> = [
  { value: "none", label: "apps.accessNone" },
  { value: "view", label: "apps.accessView" },
  { value: "edit", label: "apps.accessEdit" },
];

/** Who else in a group may use an app put there, "only me for now" first. `name` groups its radio buttons. */
export function WhoCanUse({ name, value, onChange }: { name: string; value: MemberAccess; onChange: (value: MemberAccess) => void }) {
  const { t } = useI18n();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-3">{t("apps.addWho")}</legend>
      {ACCESS_CHOICES.map((choice) => (
        <label key={choice.value} className="flex min-h-7 cursor-pointer items-center gap-2.5 max-md:min-h-11">
          <input
            type="radio"
            name={`${name}-access`}
            value={choice.value}
            className={RADIO}
            checked={value === choice.value}
            onChange={() => onChange(choice.value)}
          />
          <span>{t(choice.label)}</span>
        </label>
      ))}
      <p className="text-xs text-fg-3">{t("apps.addWhoHint")}</p>
    </fieldset>
  );
}
