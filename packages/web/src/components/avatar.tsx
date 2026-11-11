import { cx } from "../lib/cx";

/** The first character of a name, upper-cased. Works for Chinese names and for emoji. */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0] ?? "";
  return first.toLocaleUpperCase();
}

export type AvatarProps = {
  name: string;
  size?: "md" | "lg";
  className?: string;
};

/** A round badge with a person's initial. Decorative: put the name next to it. */
export function Avatar({ name, size = "md", className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex flex-none items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-fg",
        size === "lg" ? "size-10 text-lg" : "size-7 text-xs",
        className,
      )}
    >
      {initialOf(name) || "?"}
    </span>
  );
}
