import type { Metadata } from "next";
import { Workspace } from "@/ui/workspace/Workspace";

export const metadata: Metadata = { title: "Studio projects | Setti", robots: { index: false, follow: false } };
export default function StudioPage() { return <Workspace initialView="projects" initialCase="maple" initialQuote="maple" initialAccount="jordan" />; }
