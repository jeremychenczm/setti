"use client";

import { ArrowRight, Check, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import { EndDemoButton } from "./EndDemoButton";

/**
 * The bar above a walkthrough: a way to end the demo on the left, the numbered
 * steps in the middle, and under them the one next step with its action. Every
 * walkthrough uses the same bar; `tools` and `children` add what one
 * walkthrough needs on top.
 */
export function GuideBar({ label, steps, step, action, onAction, tools, children, error, busy = false }: {
  label: string;
  steps: readonly string[];
  step: { index: number; title: string; detail: string; complete?: boolean };
  action: string;
  onAction: () => void;
  /** Small controls on the right of the top row. */
  tools?: ReactNode;
  /** Rows under the next step. */
  children?: ReactNode;
  error?: string | null;
  /** The action is running. */
  busy?: boolean;
}) {
  const done = (index: number) => index < step.index || (index === step.index && !!step.complete);
  return <aside aria-label={label} className="shrink-0 rounded-xl border border-[var(--primary-line)] bg-[var(--primary-soft)] px-4 py-2.5 text-[var(--ink)]">
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <div className="justify-self-start"><EndDemoButton large className="rounded-lg border border-[var(--primary-line)] bg-white/70 px-2.5 py-1 text-[12px] font-medium text-brand-800 hover:bg-white" /></div>
      <ol aria-label={`Step ${step.index + 1} of ${steps.length}`} className="flex flex-wrap items-center justify-center gap-1.5">
        {steps.map((name, index) => <li key={name} title={name} aria-current={step.index === index ? "step" : undefined} className="flex items-center gap-1.5">
          {index > 0 && <span aria-hidden className={`h-px w-4 sm:w-7 ${index <= step.index ? "bg-[var(--primary)]" : "bg-[var(--primary-line)]"}`} />}
          <span className={`flex h-[22px] w-[22px] items-center justify-center rounded-full text-[10px] font-semibold ${done(index) ? "bg-[var(--primary)] text-white" : index === step.index ? "border-2 border-[var(--primary)] bg-white text-[var(--primary)]" : "border border-[var(--primary-line)] bg-white text-[var(--muted)]"}`}>
            {done(index) ? <Check className="h-3 w-3" /> : index + 1}<span className="sr-only">{name}</span>
          </span>
        </li>)}
        <li className="ml-1.5 hidden text-[11px] text-[var(--muted)] md:block">Step {step.index + 1} of {steps.length} · {steps[step.index]}</li>
      </ol>
      <div className="flex flex-wrap items-center justify-end gap-1 justify-self-end">{tools}</div>
    </div>
    {/* The next step in the middle, its action on the right. */}
    <div className="mt-2 grid items-center gap-x-4 gap-y-2 sm:grid-cols-[1fr_minmax(0,46rem)_1fr]">
      <div aria-hidden className="hidden sm:block" />
      <div className="min-w-0 text-center">
        <h2 className="text-[14px] font-semibold leading-snug">{step.title}</h2>
        <p title={step.detail} className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed text-slate-600">{step.detail}</p>
      </div>
      <div className="flex justify-center sm:justify-end">
        <button type="button" onClick={onAction} disabled={busy} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-fill)] px-3.5 py-2 text-[12px] font-semibold text-[var(--on-primary)] hover:bg-[var(--primary-hover)] disabled:cursor-wait disabled:opacity-70">{busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}{action}{!busy && <ArrowRight className="h-3.5 w-3.5" />}</button>
      </div>
    </div>
    {children && <div className="mx-auto max-w-3xl text-center">{children}</div>}
    {error && <p role="status" className="mt-2 text-center text-[11px] leading-relaxed text-amber-800">{error}</p>}
  </aside>;
}

/** The look of a small control in the bar's top row. */
export const GUIDE_TOOL = "inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-brand-700 hover:bg-brand-100";
