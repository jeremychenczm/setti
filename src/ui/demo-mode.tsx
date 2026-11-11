"use client";
/**
 * Whether the page belongs to a visitor's demo. Demo-only labels and the sample
 * values the demo fills in (a fictional supplier's order number, for example)
 * show only then; a real studio's pages never call anything a demo.
 */
import { createContext, useContext } from "react";

const DemoMode = createContext(false);

export const DemoModeProvider = DemoMode.Provider;

export function useDemoMode(): boolean {
  return useContext(DemoMode);
}
