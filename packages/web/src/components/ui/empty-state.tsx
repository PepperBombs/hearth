import type { ReactNode } from "react";
import { cx } from "../../lib/cx";

export type EmptyStateProps = {
  /** A 20px icon, shown in a soft round badge. */
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  /** A button or link offering the next step. */
  action?: ReactNode;
  /** Heading level of the title. */
  level?: 2 | 3;
  className?: string;
};

/** What a screen shows when it has nothing to list: what belongs here, and why it is empty. */
export function EmptyState({ icon, title, children, action, level = 2, className }: EmptyStateProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cx("mx-auto flex max-w-[420px] flex-col items-center gap-2 px-2 py-8 text-center", className)}>
      {icon ? (
        <span
          aria-hidden="true"
          className="mb-1 inline-flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent-fg"
        >
          {icon}
        </span>
      ) : null}
      <Heading className="text-lg font-semibold">{title}</Heading>
      {children ? <p className="text-fg-2">{children}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
