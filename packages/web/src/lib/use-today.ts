import { useEffect, useState } from "react";

/** Milliseconds from `now` until one second into the next day, by this device's clock. */
export function msUntilTomorrow(now: Date): number {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return tomorrow.getTime() - now.getTime();
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * Today's date, kept right while the page stays open.
 *
 * It changes at midnight. A timer alone is not enough: a phone or a laptop
 * that sleeps through midnight does not run timers, so the date is also
 * checked whenever the page is shown again or gets the focus back.
 */
export function useToday(): Date {
  const [today, setToday] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitForMidnight = () => {
      clearTimeout(timer);
      timer = setTimeout(check, msUntilTomorrow(new Date()));
    };
    function check() {
      const now = new Date();
      setToday((shown) => (sameDay(shown, now) ? shown : now));
      waitForMidnight();
    }
    const whenShown = () => {
      if (document.visibilityState === "visible") check();
    };

    waitForMidnight();
    document.addEventListener("visibilitychange", whenShown);
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", whenShown);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
    };
  }, []);

  return today;
}
