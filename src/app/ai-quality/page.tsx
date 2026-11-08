import type { Metadata } from "next";
import { AiQuality } from "@/ui/ai-quality/AiQuality";
import data from "@/ui/ai-quality/eval-data.json";
import type { EvalPageData } from "@/ui/ai-quality/types";

export const metadata: Metadata = {
  title: "AI quality · Setti",
  description: "Every AI eval case in Setti: what was asked, the answer key, the model's recorded replies and how code graded them.",
};

export const dynamic = "force-static";

export default function AiQualityPage() {
  return <AiQuality data={data as EvalPageData} />;
}
