/** True on Apple devices, where the Command key takes the place of Control in shortcuts. */
export function isApplePlatform(nav: Pick<Navigator, "platform" | "userAgent"> = navigator): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(nav.platform || nav.userAgent);
}

/** How the quick switcher's shortcut is written on this device. */
export function switcherShortcut(apple: boolean = isApplePlatform()): string {
  return apple ? "⌘K" : "Ctrl K";
}

/** Whether a key press is the quick switcher's shortcut: Ctrl+K or Cmd+K, with nothing else held. */
export function isSwitcherShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}
