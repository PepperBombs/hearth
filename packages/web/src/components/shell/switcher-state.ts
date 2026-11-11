import { createContext, useContext } from "react";

export type SwitcherState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

export const SwitcherContext = createContext<SwitcherState | null>(null);

/** Opens and closes the quick switcher from anywhere in the shell. */
export function useSwitcher(): SwitcherState {
  const state = useContext(SwitcherContext);
  if (!state) throw new Error("useSwitcher must be used inside <Shell>");
  return state;
}
