"use client";

import { ArrowRight, ArrowUpRight, Check, CircleAlert, CircleCheck, Clock3, FileText, History, LoaderCircle, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { rememberAccount, type AccountId } from "@/accounts/demo";

type Stage = { id: string; label: string; status: "pending" | "running" | "done" | "failed" };
type Seed = { runId: string; status: "seeding" | "ready" | "failed"; busy: boolean; changeOrderId: string | null; stages: Stage[]; canResume: boolean; error: string | null };
type PreviousRun = { runId: string; status: Seed["status"]; createdAt: string };
type Snapshot = { seed: Seed | null; href: string; previousRuns: PreviousRun[]; hasWorkspace: boolean };
type Busy = "maple" | "willow" | "resume" | "reload" | null;
const runStatus = { seeding: "Preparation in progress", ready: "Ready to open", failed: "Needs attention" };
const stageStatus = { pending: "Waiting", running: "In progress", done: "Saved", failed: "Needs attention" };

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const body = value as Partial<Snapshot>;
  return "seed" in body && typeof body.href === "string" && Array.isArray(body.previousRuns)
    && (body.seed === null || !!body.seed && typeof body.seed.runId === "string"
      && ["seeding", "ready", "failed"].includes(body.seed.status) && Array.isArray(body.seed.stages));
}
function errorText(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") return body.error;
  if (isSnapshot(body) && body.seed?.error) return body.seed.error;
  return "The walkthrough could not be reached (HTTP " + status + ").";
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new DOMException("Stopped", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1_200);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
  });
}
function savedOn(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved walkthrough" : date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Loading this page only reads state; preparation follows an explicit user action. */
export function TryStart() {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<AccountId>("emma");
  const [confirmNew, setConfirmNew] = useState(false);
  const mounted = useRef(true);
  const working = useRef(false);
  const active = useRef<AbortController | null>(null);
  const expectedRun = useRef<string | null>(null);
  const seed = snapshot?.seed ?? null;

  const accept = useCallback((next: Snapshot) => {
    if (!mounted.current || (expectedRun.current && next.seed?.runId !== expectedRun.current)) return;
    setSnapshot((previous) => {
      if (previous?.seed && next.seed?.runId === previous.seed.runId) {
        const before = previous.seed.stages.filter((stage) => stage.status === "done").length;
        const after = next.seed.stages.filter((stage) => stage.status === "done").length;
        // Slow GET responses cannot erase provider stages already saved by a POST response.
        if (before > after || previous.seed.status === "ready" && next.seed.status !== "ready") return { ...next, seed: previous.seed };
      }
      return next;
    });
  }, []);

  const read = useCallback(async (signal: AbortSignal): Promise<Snapshot> => {
    const response = await fetch("/api/try", { cache: "no-store", signal });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(errorText(body, response.status));
    if (!isSnapshot(body)) throw new Error("The server returned incomplete walkthrough records.");
    if (!signal.aborted) accept(body);
    return body;
  }, [accept]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    // Strict-mode replay is harmless: GET does not create projects or transactions.
    void read(controller.signal).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Saved walkthroughs could not be loaded.");
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => { mounted.current = false; controller.abort(); active.current?.abort(); };
  }, [read]);

  function open(href: string, account: AccountId) {
    rememberAccount(account);
    router.push(href === "/quotes/willow" ? href : "/chats/maple");
  }

  async function post(body: object, signal: AbortSignal): Promise<Snapshot> {
    const response = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const result: unknown = await response.json().catch(() => null);
    if (isSnapshot(result) && !signal.aborted) {
      expectedRun.current = result.seed?.runId ?? null;
      accept(result);
    }
    // Preparation errors retain the run, stages and canResume in the displayed snapshot.
    if (!response.ok) throw new Error(errorText(result, response.status));
    if (!isSnapshot(result)) throw new Error("The saved run was not returned. Reload its status before continuing.");
    return result;
  }

  async function prepare(initial: Snapshot, signal: AbortSignal): Promise<Snapshot> {
    let current = initial;
    const requestedRun = initial.seed?.runId;
    while (!signal.aborted && mounted.current) {
      const run = current.seed;
      if (!run) throw new Error("The saved Maple run could not be found.");
      if (run.runId !== requestedRun) throw new Error("Another tab selected a different project. Resume the intended saved run before continuing its preparation.");
      if (run.status === "ready") return current;
      if (run.status === "failed" && !run.canResume && !run.busy) throw new Error(run.error || "This run needs attention before preparation can continue.");
      expectedRun.current = run.runId;
      if (run.busy) {
        // Another request owns this stage: read its progress rather than posting more work.
        await pause(signal);
        current = await read(signal);
      } else {
        current = await post({ action: "prepare", runId: run.runId }, signal);
        if (current.seed?.status !== "ready") await pause(signal);
      }
    }
    throw new DOMException("Stopped", "AbortError");
  }

  async function perform(kind: Exclude<Busy, null>, work: (signal: AbortSignal) => Promise<void>) {
    if (working.current) return;
    working.current = true;
    const controller = new AbortController();
    active.current = controller; expectedRun.current = null;
    setBusy(kind); setError(null); setConfirmNew(false);
    let polling = false;
    const poll = setInterval(() => {
      if (polling || controller.signal.aborted) return;
      polling = true;
      void read(controller.signal).catch(() => {}).finally(() => { polling = false; });
    }, 1_500);
    try { await work(controller.signal); }
    catch (cause) {
      if (mounted.current && !(cause instanceof Error && cause.name === "AbortError")) {
        setError(cause instanceof Error ? cause.message : "This run could not continue. Reload its saved status before retrying.");
      }
    } finally {
      clearInterval(poll); controller.abort();
      if (active.current === controller) active.current = null;
      expectedRun.current = null; working.current = false;
      if (mounted.current) { setBusy(null); setChecking(false); }
    }
  }

  function startMaple(restart = false) {
    if (working.current) return;
    if (!restart && seed?.status === "ready") return open(snapshot!.href, role);
    void perform("maple", async (signal) => {
      const initial = !restart && seed ? snapshot! : await post({ action: "start", scenario: "maple-mixed-change-v1", ...(restart ? { restart: true } : {}) }, signal);
      if (restart && seed && initial.seed?.runId === seed.runId) throw new Error("This run is still being prepared. Continue its saved preparation before creating a separate run.");
      const ready = await prepare(initial, signal);
      if (!signal.aborted && mounted.current) open(ready.href, role);
    });
  }
  function resume(runId: string) {
    void perform("resume", async (signal) => {
      const selected = await post({ action: "resume", runId }, signal);
      const ready = await prepare(selected, signal);
      if (!signal.aborted && mounted.current) open(ready.href, role);
    });
  }
  function startWillow() {
    void perform("willow", async (signal) => {
      const ready = await post({ action: "workspace", scenario: "willow-first-payment-v1" }, signal);
      if (!signal.aborted && mounted.current) open(ready.href, "sofia");
    });
  }

  const disabled = checking || busy !== null;
  return <main className="min-h-dvh bg-[var(--canvas)] px-4 py-5 text-[var(--ink)] sm:px-6 sm:py-8">
    <div className="mx-auto max-w-[1120px]">
      <header className="flex items-center gap-2.5"><Link href="/try" className="flex items-center gap-2.5"><span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--primary)] text-sm font-bold text-white">S</span><span className="text-[15px] font-semibold tracking-tight">Setti</span></Link><span className="ml-auto rounded-full border border-slate-200 bg-white px-3 py-1 text-[10px] font-medium text-slate-500">PayPal Sandbox · test money</span></header>
      <section className="pb-7 pt-10 sm:pb-9 sm:pt-14">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--primary)]">For an interior design project that keeps changing</p>
        <h1 className="mt-3 max-w-3xl text-[32px] font-semibold leading-[1.12] tracking-tight sm:text-[44px]">The agreement changed.<br /><span className="text-slate-500">Keep every dollar in step.</span></h1>
        <p className="mt-4 max-w-2xl text-[14px] leading-relaxed text-slate-600">Walk through one change from the client&rsquo;s request to the studio&rsquo;s pricing review, one signed version and each item&rsquo;s PayPal result.</p>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-labelledby="maple-walkthrough-title">
        <div className="grid lg:grid-cols-[1.1fr_1fr]">
          <div className="p-6 sm:p-8">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-blue-700"><span className="h-1.5 w-1.5 rounded-full bg-blue-600" />Recommended walkthrough · Maple Ave</div>
            <h2 id="maple-walkthrough-title" className="mt-4 text-[23px] font-semibold leading-snug tracking-tight">A chair becomes a desk.<br />The rug goes back.</h2>
            <p className="mt-3 max-w-lg text-[13px] leading-relaxed text-slate-600">Emma asks for both changes together. Jordan reviews the desk&rsquo;s sample supplier quote and the rug&rsquo;s retained cost. Emma confirms one version; Setti tracks the release, new purchase and refund separately.</p>
            <ol className="mt-5 flex flex-wrap gap-x-4 gap-y-2 text-[11px] font-medium text-slate-500">{["Ask AI", "Review prices", "Confirm", "Move money"].map((label, index) => <li key={label}><span className="mr-1.5 text-blue-700">{index + 1}</span>{label}</li>)}</ol>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" disabled={disabled} onClick={() => startMaple()} className="inline-flex items-center gap-2 rounded-xl bg-[var(--primary)] px-4 py-3 text-[13px] font-semibold text-white hover:bg-blue-600 disabled:opacity-50">{busy === "maple" || busy === "resume" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}{seed && seed.status !== "ready" ? "Continue preparing this change" : "Work through this change"}</button>
              <label className="flex items-center gap-2 text-[11px] text-slate-500">Begin as<select aria-label="Maple walkthrough starting role" value={role} disabled={disabled} onChange={(event) => setRole(event.target.value === "jordan" ? "jordan" : "emma")} className="rounded-lg border border-slate-200 bg-white px-2 py-2 text-[12px] text-slate-700"><option value="emma">Emma · client</option><option value="jordan">Jordan · designer</option></select></label>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The starting history is prepared with a Sandbox test card when you begin. You edit and send the next message yourself; its new draft uses live AI. Switch roles as the walkthrough progresses.</p>
            {checking && <p role="status" className="mt-4 flex items-center gap-2 text-[11px] text-slate-500"><LoaderCircle className="h-3.5 w-3.5 animate-spin" />Checking saved walkthroughs…</p>}
            {seed?.status === "ready" && <p className="mt-4 flex items-center gap-2 text-[11px] font-medium text-emerald-700"><CircleCheck className="h-4 w-4" />Your saved Maple run is ready. Open the same project to continue.</p>}
          </div>
          <div className="border-t border-slate-200 bg-slate-50/70 p-6 sm:p-8 lg:border-l lg:border-t-0">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Starting point · prepared when you begin</p>
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-3 rounded-xl border border-blue-100 bg-white px-4 py-3"><span className="mr-auto text-[12px] font-medium">Lounge chair</span><span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-semibold text-blue-700">Held</span><span className="text-[15px] font-semibold tabular-nums">$800</span></div>
              <div className="flex items-center gap-3 rounded-xl border border-emerald-100 bg-white px-4 py-3"><span className="mr-auto text-[12px] font-medium">Wool rug</span><span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">Captured</span><span className="text-[15px] font-semibold tabular-nums">$300</span></div>
            </div>
            <p className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Intended result after the new version is confirmed</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">{[{ label: "Release chair hold", value: "$800" }, { label: "New desk purchase", value: "$1,100" }, { label: "Refund rug", value: "$240" }].map((item) => <div key={item.label} className="rounded-xl bg-white px-2 py-3"><p className="text-[10px] text-slate-500">{item.label}</p><p className="mt-1 text-[17px] font-semibold tabular-nums">{item.value}</p></div>)}</div>
            <div className="mt-3 rounded-xl border border-slate-200 px-4 py-3 text-[11px] leading-relaxed text-slate-600"><strong className="font-semibold text-slate-800">Quote change: +$60.</strong> The rug&rsquo;s $60 retained cost stays in the agreement. A budget change and today&rsquo;s payment steps are different numbers.</div>
            <p className="mt-4 text-[10px] leading-relaxed text-slate-500">Fictional client, products and supplier terms. Prepared money records use real PayPal Sandbox transactions. Supplier confirmations are entered for the demo; no real money moves.</p>
          </div>
        </div>
      </section>

      {seed && <section aria-labelledby="preparation-title" aria-live="polite" className="mt-4 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2"><h2 id="preparation-title" className="mr-auto text-[13px] font-semibold">Your saved Maple preparation</h2><span className="text-[10px] text-slate-500">{runStatus[seed.status]}</span></div>
        <ol className="mt-4 grid gap-3 sm:grid-cols-2">{seed.stages.map((stage) => <li key={stage.id} className="flex items-start gap-2.5 text-[12px] leading-relaxed">
          {stage.status === "done" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : stage.status === "running" ? <LoaderCircle className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-blue-600" /> : stage.status === "failed" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" /> : <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />}
          <span className={stage.status === "pending" ? "text-slate-400" : "text-slate-700"}>{stage.label}<span className="ml-2 text-[10px] text-slate-400">{stageStatus[stage.status]}</span></span>
        </li>)}</ol>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-500">Progress comes from saved server records. If you leave, the current request may finish; return here to continue this same run and its existing payment operations.</p>
        {seed.error && <p className="mt-3 text-[11px] leading-relaxed text-amber-800">{seed.error}</p>}
        {seed.changeOrderId && seed.status !== "ready" && <button type="button" disabled={disabled} onClick={() => open(snapshot!.href, role)} className="mt-3 text-[11px] font-medium text-[var(--primary)] underline disabled:opacity-50">View this run&rsquo;s saved project records</button>}
      </section>}

      {error && <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-[12px] leading-relaxed text-amber-900"><p>{error}</p><p className="mt-1 text-[11px]">Read-only examples remain available below. Saved payment outcomes stay with their run.</p><button type="button" disabled={busy !== null} onClick={() => { void perform("reload", async (signal) => { await read(signal); }); }} className="mt-3 inline-flex items-center gap-1.5 font-semibold underline disabled:opacity-50"><RefreshCw className="h-3.5 w-3.5" />Reload saved status</button></div>}

      {seed && <div className="mt-3 px-1">{!confirmNew ? <button type="button" disabled={disabled} onClick={() => setConfirmNew(true)} className="text-[11px] font-medium text-slate-500 underline disabled:opacity-50">Start a separate Maple run</button> : <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4"><p className="min-w-[230px] flex-1 text-[11px] leading-relaxed text-slate-600">A separate run keeps this project and its payment records available in your saved runs. Starting again does not cancel its holds, refund payments or clear unknown outcomes.</p><button type="button" disabled={disabled} onClick={() => startMaple(true)} className="rounded-lg bg-[var(--primary)] px-3 py-2 text-[11px] font-semibold text-white disabled:opacity-50">Create a separate run</button><button type="button" onClick={() => setConfirmNew(false)} className="text-[11px] text-slate-500 underline">Keep this run</button></div>}</div>}

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"><FileText className="h-5 w-5 text-blue-600" /><h2 className="mt-3 text-[15px] font-semibold">Start before any money moves</h2><p className="mt-2 text-[12px] leading-relaxed text-slate-600">Open Willow&rsquo;s prepared first quote as Sofia. Approve items, pay the design services and see how saved PayPal holds each approved product.</p><button type="button" disabled={disabled} onClick={startWillow} className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--primary)] underline disabled:opacity-50">{busy === "willow" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}Start with first quote</button><p className="mt-3 text-[10px] text-slate-400">Opening this prepared quote makes no payment call. You choose its next steps.</p></section>
        <section className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"><History className="h-5 w-5 text-slate-500" /><h2 className="mt-3 text-[15px] font-semibold">Explore the money states</h2><p className="mt-2 text-[12px] leading-relaxed text-slate-600">Compare a hold, a capture, a refund and an unknown result. Read example stories and evidence without preparing a workspace.</p><Link href="/try/cases" className="mt-4 inline-flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 underline">Browse read-only examples<ArrowUpRight className="h-3.5 w-3.5" /></Link><p className="mt-3 text-[10px] text-slate-400">Available even when demo storage or PayPal cannot be reached.</p></section>
      </div>

      {!!snapshot?.previousRuns.length && <section aria-labelledby="previous-runs-title" className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
        <h2 id="previous-runs-title" className="flex items-center gap-2 text-[13px] font-semibold"><History className="h-4 w-4 text-slate-400" />Previous Maple runs</h2>
        <ul className="mt-3 divide-y divide-slate-100">{snapshot.previousRuns.map((run) => <li key={run.runId} className="flex flex-wrap items-center gap-3 py-3"><div className="mr-auto"><p className="text-[12px] font-medium">{savedOn(run.createdAt)}</p><p className="mt-1 text-[10px] text-slate-500">{runStatus[run.status]}</p></div><button type="button" disabled={disabled} onClick={() => resume(run.runId)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--primary)] underline disabled:opacity-50">{run.status === "ready" ? "Open saved run" : "Resume this run"}<ArrowRight className="h-3 w-3" /></button></li>)}</ul>
      </section>}
      <footer className="py-7 text-[10px] leading-relaxed text-slate-400">Private demo workspace · fictional project history · real PayPal Sandbox where indicated · no production payments</footer>
    </div>
  </main>;
}
