"use client";

import { ArrowLeft, ArrowRight, Check, Eye, FileCheck2, LockKeyhole } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DEMO_CASES } from "@/demo/case-gallery";

/** Static teaching examples never get passed to a project or payment API. */
export function TryCaseGallery() {
  const [selected, setSelected] = useState<string>("held");
  const current = DEMO_CASES.find((item) => item.id === selected) ?? DEMO_CASES[1];
  function selectCase(id: string) {
    setSelected(id);
    if (window.innerWidth < 1024) window.requestAnimationFrame(() => {
      const detail = document.getElementById("demo-case-detail");
      detail?.focus({ preventScroll: true });
      detail?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  return <main className="min-h-dvh bg-[var(--canvas)] px-5 py-7 text-[var(--ink)] sm:px-8"><div className="mx-auto max-w-[1120px]">
    <header className="flex flex-wrap items-center justify-between gap-3"><Link href="/" className="inline-flex items-center gap-2 text-[12px] font-medium text-slate-500"><ArrowLeft className="h-3.5 w-3.5" />Back to Setti</Link><span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-[10px] text-slate-500"><LockKeyhole className="h-3 w-3" />Read-only cases · no payment calls</span></header>
    <div className="pb-8 pt-10"><p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--primary)]">The studio&rsquo;s money, explained</p><h1 className="mt-3 text-[32px] font-semibold tracking-tight sm:text-[40px]">Every state has a reason.</h1><p className="mt-3 max-w-[690px] text-[13px] leading-7 text-slate-500">Explore what happened, who needs to act and what proves the result. These six cases are fictional teaching examples. The dated Sandbox recording below is separate from your own project.</p></div>
    <div className="grid gap-5 lg:grid-cols-[320px_1fr]">
      <nav aria-label="Demo cases" className="grid grid-cols-2 content-start gap-2 lg:grid-cols-1">{DEMO_CASES.map((item) => <button key={item.id} aria-pressed={item.id === selected} onClick={() => selectCase(item.id)} className={`rounded-xl border p-4 text-left transition ${item.id === selected ? "border-brand-300 bg-white shadow-sm ring-1 ring-brand-100" : "border-slate-200 bg-white/60 hover:border-brand-200"}`}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] font-medium text-brand-600">{item.status}</span><span className="text-[10px] text-slate-400">{item.amount}</span></div><p className="mt-2 text-[13px] font-semibold">{item.title}</p><p className="mt-1 text-[10px] text-slate-400">{item.project}</p></button>)}</nav>
      <section id="demo-case-detail" tabIndex={-1} aria-live="polite" aria-atomic="true" className="scroll-mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm outline-none sm:p-8">
        <div className="flex flex-wrap gap-2 text-[9px]"><span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-500">Illustrative demo data</span><span className="rounded-full bg-brand-50 px-2.5 py-1 text-brand-700">{current.status}</span></div>
        <p className="mt-6 text-[11px] text-slate-400">{current.project}</p><h2 className="mt-2 text-[23px] font-semibold leading-snug tracking-tight">{current.question}</h2><p className="mt-4 text-[13px] leading-7 text-slate-600">{current.answer}</p>
        <ol className="mt-6 space-y-4 border-t border-slate-100 pt-6">{current.events.map((event, index) => <li key={event.actor} className="flex gap-3"><span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-400">{index + 1}</span><div><p className="text-[10px] font-semibold text-slate-500">{event.actor}</p><p className="mt-1 text-[12px] leading-6 text-slate-600">{event.text}</p></div></li>)}</ol>
        <div className="mt-6 rounded-xl bg-brand-50 p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-brand-700">Who acts next?</p><p className="mt-2 text-[12px] leading-6 text-brand-900">{current.next}</p></div>
        <div className="mt-5"><h3 className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600"><Eye className="h-3.5 w-3.5" />What to inspect</h3><p className="mt-2 text-[12px] leading-6 text-slate-500">{current.inspect}</p></div>
      </section>
    </div>
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-8">
      <div className="flex flex-wrap items-center gap-2"><FileCheck2 className="h-4 w-4 text-emerald-600" /><h2 className="text-[16px] font-semibold">A recorded Sandbox run</h2><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-[9px] font-medium text-emerald-700">Recorded · 22 Oct 2026</span></div>
      <p className="mt-3 max-w-[780px] text-[12px] leading-6 text-slate-500">The proof runner completed the Maple change against PayPal Sandbox and read the resources back. All 14 checks passed at that time. The runner deliberately discarded the refund response, then recovered it by checking the same operation.</p>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">{[{ amount: "$800", label: "Chair hold released" }, { amount: "$1,100", label: "Desk captured" }, { amount: "$240", label: "Rug refunded" }].map((item) => <div key={item.label} className="rounded-xl border border-emerald-100 bg-emerald-50/30 p-4"><p className="text-[23px] font-semibold tracking-tight">{item.amount}</p><p className="mt-1 flex items-center gap-1 text-[10px] text-emerald-700"><Check className="h-3 w-3" />{item.label}</p></div>)}</div>
      <details className="mt-5 rounded-xl border border-slate-200 p-4 text-[11px]"><summary className="cursor-pointer font-medium text-slate-600">Inspect recorded references and limits</summary><dl className="mt-4 grid gap-3 leading-6 text-slate-500 sm:grid-cols-2"><div><dt>Recorded (UTC)</dt><dd className="font-mono text-[10px]">2026-10-22T07:16:36.874Z</dd></div><div><dt>Code revision at recording</dt><dd className="font-mono text-[10px]">90f978f</dd></div><div><dt>Released chair authorisation</dt><dd className="select-all font-mono text-[10px]">1GM257889T578012B</dd></div><div><dt>Completed desk capture</dt><dd className="select-all font-mono text-[10px]">9RA17236TV607770F</dd></div><div><dt>Recovered rug refund</dt><dd className="select-all font-mono text-[10px]">0FS14777WJ130534X</dd></div><div><dt>Duplicate-refund check</dt><dd>Exactly one matching PayPal refund.</dd></div></dl><p className="mt-4 border-t border-slate-100 pt-4 leading-6 text-slate-500">Source: evidence/2026-10-22-mixed-change-lost-refund-answer/README.md and provider-verification.json in the repository. The proof used a fixed AI draft and designer-entered supplier records. It is a historical recording; it does not confirm the current build or today&rsquo;s balance. These resources cannot be operated from this gallery.</p></details>
    </section>
    <footer className="flex flex-wrap items-center justify-between gap-4 py-7 text-[11px] text-slate-400"><span>Example states do not become executable project records.</span><Link href="/try" className="inline-flex items-center gap-1.5 font-semibold text-[var(--primary)]">Try the change yourself<ArrowRight className="h-3.5 w-3.5" /></Link></footer>
  </div></main>;
}
