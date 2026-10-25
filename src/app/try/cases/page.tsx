import type { Metadata } from "next";
import { TryCaseGallery } from "@/ui/try/TryCaseGallery";

export const metadata: Metadata = { title: "Cases and recorded proof | Try Setti", robots: { index: false, follow: false } };
export default function TryCasesPage() { return <TryCaseGallery />; }
