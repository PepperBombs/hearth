import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { cx } from "../../lib/cx";

export type DialogProps = {
  open: boolean;
  /** Called when the dialog asks to close: Escape, a click outside, or the browser's back gesture. */
  onClose: () => void;
  /** Names the dialog for screen readers. */
  label: string;
  children: ReactNode;
  /**
   * Where the box sits and how big it is. Replaces the default (centred, up to 460px wide)
   * as a whole, so give margin, width, maximum size and corner radius together.
   */
  layoutClassName?: string;
};

/**
 * A modal dialog built on the browser's own <dialog>. Opening it with
 * showModal() puts it above everything, makes the rest of the page inert,
 * keeps keyboard focus inside, closes on Escape, and gives focus back to
 * whatever had it before. Children are mounted only while it is open.
 */
const DEFAULT_LAYOUT = "m-auto max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[460px] rounded-card border";

export function Dialog({ open, onClose, label, children, layoutClassName = DEFAULT_LAYOUT }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  /** A click on the backdrop lands on the <dialog> element itself, never on its content. */
  const closeOnBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  return (
    <dialog
      ref={ref}
      aria-label={label}
      onClose={onClose}
      onClick={closeOnBackdrop}
      className={cx(
        "overflow-hidden border-line bg-surface p-0 text-fg shadow-pop backdrop:bg-overlay",
        "motion-safe:open:animate-[hearth-pop_.14s_ease-out]",
        layoutClassName,
      )}
    >
      {open ? children : null}
    </dialog>
  );
}

/** The padded column most dialogs want inside: a title, some text, a row of buttons. */
export function DialogBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex flex-col gap-3.5 p-5", className)}>{children}</div>;
}
