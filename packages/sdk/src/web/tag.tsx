import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * A small label that marks something, such as the space an app belongs to. Not clickable.
 *
 * Its text is whatever people named things, so it can be long. It stays on
 * one line and is cut with an ellipsis when there is no room, rather than
 * pushing what stands next to it out of view.
 */
export function Tag({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cx(
        "clip inline-block h-5 max-w-full min-w-7 rounded-full bg-accent-soft px-[7px] text-center align-middle text-2xs leading-5 font-medium text-accent-fg",
        className,
      )}
      {...rest}
    />
  );
}
