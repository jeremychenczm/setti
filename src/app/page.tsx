import type { Metadata } from "next";
import { Landing } from "@/ui/landing/Landing";

export const metadata: Metadata = {
  title: "Setti · Settle the design in a chat, settle up in PayPal",
  description: "Design evolves through conversation. Setti's AI spots changes, drafts revised quotes, and links each approval to PayPal holds, charges and refunds.",
};

export const dynamic = "force-static";

export default function Home() {
  return <Landing />;
}
