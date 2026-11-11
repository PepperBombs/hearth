import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msUntilTomorrow, useToday } from "./use-today";

describe("msUntilTomorrow", () => {
  it("is the time left until one second past midnight", () => {
    expect(msUntilTomorrow(new Date(2026, 10, 10, 23, 59, 30))).toBe(31_000);
    expect(msUntilTomorrow(new Date(2026, 10, 10, 0, 0, 0))).toBe(24 * 60 * 60 * 1000 + 1000);
  });

  it("crosses the end of a month and of a year", () => {
    expect(msUntilTomorrow(new Date(2026, 11, 31, 23, 0, 0))).toBe(60 * 60 * 1000 + 1000);
  });
});

describe("useToday", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date(2026, 10, 10, 23, 59, 30) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("changes at midnight while the page stays open, and again the night after", () => {
    const { result } = renderHook(() => useToday());
    expect(result.current.getDate()).toBe(10);

    act(() => void vi.advanceTimersByTime(29_000));
    expect(result.current.getDate()).toBe(10);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(result.current.getDate()).toBe(11);

    act(() => void vi.advanceTimersByTime(24 * 60 * 60 * 1000));
    expect(result.current.getDate()).toBe(12);
  });

  it("catches up when the page is shown again after the device slept through midnight", () => {
    const { result } = renderHook(() => useToday());
    // The clock moves on, but no timer runs: that is what sleep looks like.
    vi.setSystemTime(new Date(2026, 10, 11, 7, 30, 0));
    expect(result.current.getDate()).toBe(10);

    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.getDate()).toBe(11);
  });

  it("catches up when the window gets the focus back", () => {
    const { result } = renderHook(() => useToday());
    vi.setSystemTime(new Date(2026, 10, 12, 9, 0, 0));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current.getDate()).toBe(12);
  });

  it("keeps the same value while the day has not changed", () => {
    const { result } = renderHook(() => useToday());
    const first = result.current;
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe(first);
  });

  it("stops watching when it is no longer used", () => {
    const { unmount } = renderHook(() => useToday());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
