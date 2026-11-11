import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

export type SwitchProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange" | "role" | "aria-checked"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Read by screen readers. Leave out only when aria-labelledby is given. */
  label?: string;
};

/** An on/off switch. The visible track is small; an invisible margin widens the touch target. */
export function Switch({ checked, onCheckedChange, label, className, ...rest }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onCheckedChange(!checked)}
      className={cx(
        "relative h-5 w-9 flex-none rounded-full bg-fg-3 aria-checked:bg-accent disabled:cursor-not-allowed disabled:opacity-55",
        "before:absolute before:-inset-3 before:content-['']",
        "after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:content-['']",
        "after:transition-transform after:duration-150 aria-checked:after:translate-x-4 aria-checked:after:bg-on-accent",
        className,
      )}
      {...rest}
    />
  );
}
