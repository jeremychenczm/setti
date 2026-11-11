"use client";
/**
 * Whether the page belongs to a visitor's demo. Demo-only labels and the sample
 * values the demo fills in (a fictional supplier's order number, for example)
 * show only then; a real studio's pages never call anything a demo.
 */
import { createContext, useContext, type ReactNode } from "react";

const DemoMode = createContext(false);

/** A component, not the context object itself, so server pages can render it too. */
export function DemoModeProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <DemoMode.Provider value={value}>{children}</DemoMode.Provider>;
}

export function useDemoMode(): boolean {
  return useContext(DemoMode);
}
