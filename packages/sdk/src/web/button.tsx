import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "default" | "primary";
export type ButtonSize = "md" | "sm";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-ctl border font-medium whitespace-nowrap select-none " +
  "disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55";

const VARIANTS: Record<ButtonVariant, string> = {
  default: "border-line bg-surface text-fg hover:bg-surface-2",
  primary: "border-accent bg-accent text-on-accent hover:opacity-[.92]",
};

/** Controls grow to a 44px touch target on phones. */
const SIZES: Record<ButtonSize, string> = {
  md: "h-[34px] px-3 max-md:h-11 max-md:px-4",
  sm: "h-7 px-2 text-xs max-md:h-11 max-md:px-3",
};

/** The button look as a class string, for links that should look like buttons. */
export function buttonClass(options: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cx(BASE, VARIANTS[options.variant ?? "default"], SIZES[options.size ?? "md"], options.className);
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({ variant, size, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...rest} />;
}

export type IconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> & {
  /** Read by screen readers; there is no visible text. */
  label: string;
  children: ReactNode;
};

/** A square button holding only an icon. */
export function IconButton({ label, className, type = "button", children, ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-[34px] flex-none items-center justify-center rounded-ctl bg-transparent text-fg-2",
        "hover:bg-hover hover:text-fg max-md:size-11",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
