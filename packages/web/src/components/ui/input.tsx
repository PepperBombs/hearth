import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "../../lib/cx";

/** A single-line text box. On phones it is 44px tall and uses 16px text so iOS does not zoom in. */
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-9 w-full rounded-ctl border border-line bg-surface px-2.5 text-fg placeholder:text-fg-3",
        "aria-invalid:border-down disabled:opacity-55 max-md:h-11 max-md:text-lg",
        className,
      )}
      {...rest}
    />
  );
}

export type FieldProps = {
  label: ReactNode;
  /** Shown under the control in small muted text. */
  hint?: ReactNode;
  className?: string;
  /**
   * The control. A function receives the ids to put on the control, so the label and hint are
   * announced with it. Plain children are for groups that carry their own aria-label.
   */
  children: ReactNode | ((ids: { id: string; hintId: string | undefined }) => ReactNode);
};

/** A label, a control and an optional hint, stacked. */
export function Field({ label, hint, className, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const linked = typeof children === "function";
  return (
    <div className={cx("flex flex-col items-start gap-1.5", className)}>
      {linked ? (
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      {linked ? children({ id, hintId }) : children}
      {hint ? (
        <span id={hintId} className="text-xs text-fg-3">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
