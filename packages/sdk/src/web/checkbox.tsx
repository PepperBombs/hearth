import { Check } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "checked" | "onChange" | "children"> & {
  checked: boolean;
  /** Called with the new state when the box, or its text, is pressed. */
  onChange: (checked: boolean) => void;
  /** The text beside the box. A press on it ticks the box too. */
  children?: ReactNode;
  /** Read by screen readers. Give it only when there is no text beside the box. */
  label?: string;
};

/**
 * A tick box with its text. The browser's own checkbox does the work, so it
 * is reached with Tab, ticked with Space and announced as a checkbox; only
 * its look is replaced. On phones the row grows to a 44px touch target.
 *
 * When disabled the box is dimmed and the text is not: a list that someone
 * may only look at stays easy to read.
 */
export function Checkbox({ checked, onChange, children, label, className, ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        "inline-flex min-w-0 cursor-pointer items-center gap-2.5 has-[:disabled]:cursor-not-allowed max-md:min-h-11",
        className,
      )}
    >
      {/* An invisible margin widens the touch target, as on the switch. */}
      <span
        className={cx(
          "relative inline-flex size-[18px] flex-none has-[:disabled]:opacity-55",
          "before:absolute before:-inset-2 before:content-['']",
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          aria-label={label}
          onChange={(event) => onChange(event.currentTarget.checked)}
          className={cx(
            "peer size-full appearance-none rounded-check border border-fg-3 bg-surface",
            "checked:border-accent checked:bg-accent",
          )}
          {...rest}
        />
        {/* The class, not the attribute: the shell's rule for Lucide icons would win over an attribute. */}
        <Check
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 m-auto stroke-[2.5] text-on-accent opacity-0 peer-checked:opacity-100"
        />
      </span>
      {children != null && children !== false ? <span className="min-w-0">{children}</span> : null}
    </label>
  );
}
