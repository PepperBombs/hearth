import { cx } from "../../lib/cx";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Language of the label when it differs from the page, such as "中文" on an English page. */
  lang?: string;
};

export type SegmentedProps<T extends string> = {
  /** Names the group for screen readers. */
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  className?: string;
};

/** A row of mutually exclusive choices, one of which is pressed. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={cx("inline-flex gap-0.5 rounded-ctl bg-surface-2 p-0.5", className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          lang={option.lang}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cx(
            "h-7 rounded-seg px-3 text-sm text-fg-2 max-md:h-10 max-md:px-4",
            "aria-pressed:bg-surface aria-pressed:font-medium aria-pressed:text-fg aria-pressed:shadow-seg",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
