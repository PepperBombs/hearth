import type { ButtonHTMLAttributes } from "react";
import { cx } from "./cx";

/** The chip look as a class string, for links: mark the current one with aria-current="page". */
export function chipClass(className?: string): string {
  return cx(
    "inline-flex h-7 items-center rounded-full border border-line bg-transparent px-2.5 text-sm text-fg-2 max-md:h-9 max-md:px-3.5",
    "aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:font-medium aria-pressed:text-accent-fg",
    "aria-[current=page]:border-accent aria-[current=page]:bg-accent-soft aria-[current=page]:font-medium aria-[current=page]:text-accent-fg",
    className,
  );
}

export type ChipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & {
  /** Whether this choice is switched on. */
  pressed: boolean;
};

/** A small pill that toggles one choice among several that can be combined. */
export function Chip({ pressed, className, type = "button", ...rest }: ChipProps) {
  return <button type={type} aria-pressed={pressed} className={chipClass(className)} {...rest} />;
}
