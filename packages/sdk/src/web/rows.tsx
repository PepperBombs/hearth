import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/** A list of rows separated by hairlines, as used inside cards. */
export function Rows({ className, ...rest }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cx("flex flex-col", className)} {...rest} />;
}

export function Row({ className, ...rest }: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      className={cx(
        "flex min-h-9 min-w-0 items-center gap-2.5 border-t border-line py-1.5 first:border-t-0 max-md:min-h-11",
        className,
      )}
      {...rest}
    />
  );
}
