"use client";

import { ArrowRight, Check } from "lucide-react";
import type { ReactNode } from "react";
import { EndDemoButton } from "./EndDemoButton";

/**
 * The bar above a walkthrough: where it stands in numbered steps, the one next
 * step with its action, and a way to end the demo. Every walkthrough uses the
 * same bar; `tools` and `children` add what one walkthrough needs on top.
 */
export function GuideBar({ label, steps, step, action, onAction, tools, children, error }: {
  label: string;
  steps: readonly string[];
  step: { index: number; title: string; detail: string; complete?: boolean };
  action: string;
  onAction: () => void;
  /** Small controls beside End demo & reset. */
  tools?: ReactNode;
  /** Rows under the next step. */
  children?: ReactNode;
  error?: string | null;
}) {
  const done = (index: number) => index < step.index || (index === step.index && !!step.complete);
  return <aside aria-label={label} className="shrink-0 rounded-xl border border-[var(--primary-line)] bg-[var(--primary-soft)] px-4 py-3 text-[var(--ink)]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ol aria-label={`Step ${step.index + 1} of ${steps.length}`} className="flex flex-1 flex-wrap items-center gap-1.5">
        {steps.map((name, index) => <li key={name} title={name} aria-current={step.index === index ? "step" : undefined} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className={`h-px w-4 sm:w-6 ${index <= step.index ? "bg-[var(--primary)]" : "bg-[var(--primary-line)]"}`} />}
          <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-[9px] font-semibold ${done(index) ? "bg-[var(--primary)] text-white" : index === step.index ? "border-2 border-[var(--primary)] bg-white text-[var(--primary)]" : "border border-[var(--primary-line)] bg-white text-[var(--muted)]"}`}>
            {done(index) ? <Check className="h-2.5 w-2.5" /> : index + 1}<span className="sr-only">{name}</span>
          </span>
        </li>)}
        <li className="ml-1.5 text-[10px] text-[var(--muted)]">Step {step.index + 1} of {steps.length} · {steps[step.index]}</li>
      </ol>
      {tools}
      <EndDemoButton className={GUIDE_TOOL} />
    </div>
    <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-[220px] flex-1">
        <h2 className="text-[13px] font-semibold leading-snug">{step.title}</h2>
        <p title={step.detail} className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-slate-600">{step.detail}</p>
      </div>
      <button type="button" onClick={onAction} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)]">{action}<ArrowRight className="h-3.5 w-3.5" /></button>
    </div>
    {children}
    {error && <p role="status" className="mt-2 text-[10px] leading-relaxed text-amber-800">{error}</p>}
  </aside>;
}

/** The look of a small control in the bar's top row. */
export const GUIDE_TOOL = "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-brand-700 hover:bg-brand-100";
