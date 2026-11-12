/**
 * Time for tests of what waits: a clock that moves only when told. Not part
 * of the running server.
 */
import type { Clock } from "./fetch";

/** Lets every promise that waits for nothing but other promises settle. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock that moves only when told, and then runs what falls due, in order. It starts at 0. */
export function fakeClock() {
  let time = 0;
  let order = 0;
  let timers: { at: number; order: number; then: () => void }[] = [];
  const clock: Clock = {
    now: () => time,
    after(ms, then) {
      const timer = { at: time + ms, order: order++, then };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
  };
  return {
    clock,
    /** The timers still waiting. */
    pending: () => timers.length,
    async advance(ms: number): Promise<void> {
      const end = time + ms;
      await settle();
      for (;;) {
        const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.order - b.order)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        time = due.at;
        due.then();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}
