import type { Metadata } from "next";
import { TryStart } from "@/ui/try/TryStart";

export const metadata: Metadata = { title: "Try Setti", robots: { index: false, follow: false } };

export default function TryPage() {
  return <TryStart />;
}
