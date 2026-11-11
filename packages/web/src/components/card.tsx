import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx";

/** A white panel with a hairline border. Rendered as a <section>; give it a heading with <CardHeader>. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cx(
        "flex min-w-0 flex-col rounded-card border border-line bg-surface p-[var(--hearth-pad)] shadow-card",
        className,
      )}
      {...rest}
    />
  );
}

export type CardHeaderProps = {
  /** A 16px icon shown before the title. */
  icon?: ReactNode;
  title: ReactNode;
  /**
   * A tag shown right after the title, such as the space an app belongs to.
   * The title comes first: the tag gets the room the title leaves, and is cut short if that is not enough.
   */
  tag?: ReactNode;
  /** A short note pushed to the right edge. */
  aside?: ReactNode;
  /** Heading level of the title. Cards usually sit under the page's h1. */
  level?: 2 | 3;
  className?: string;
};

export function CardHeader({ icon, title, tag, aside, level = 2, className }: CardHeaderProps) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cx("mb-2.5 flex min-h-6 items-center gap-2 text-fg-2", className)}>
      {icon}
      <Heading
        className={cx(
          "clip min-w-0 font-semibold text-[length:var(--hearth-title-size)] text-[color:var(--hearth-title-color)]",
          "tracking-[var(--hearth-title-track)] [text-transform:var(--hearth-title-case)]",
        )}
      >
        {title}
      </Heading>
      {/* Starting from no width, this takes what is left and never squeezes the title. */}
      {tag ? <span className="flex min-w-7 flex-1">{tag}</span> : null}
      {aside ? <span className="ml-auto flex-none text-xs text-fg-3">{aside}</span> : null}
    </div>
  );
}

/** Sticks to the bottom of a card, for a "view all" link or similar. */
export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("mt-auto pt-2.5", className)} {...rest} />;
}
