import type { HTMLAttributes } from "react";
import { cx } from "../../lib/cx";

/** A small label that marks something, such as the space an app belongs to. Not clickable. */
export function Tag({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(
        "inline-flex h-5 flex-none items-center whitespace-nowrap rounded-full bg-accent-soft px-[7px] text-2xs font-medium text-accent-fg",
        className,
      )}
      {...rest}
    />
  );
}
