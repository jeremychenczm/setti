"use client";

import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleAlert, Clock3, LoaderCircle, RefreshCw } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountId } from "@/accounts/demo";
import { HOME_SCENARIO } from "@/demo/living-dining";
import styles from "./TryStart.module.css";
import { EndDemoButton } from "./EndDemoButton";
import { switchPersona } from "../account/switchPersona";
import { announceTryProgress, canOpenPreparedWorkspace } from "./TryPreparationProvider";

type Stage = { id: string; label: string; status: "pending" | "running" | "done" | "failed" };
type Seed = { runId: string; scenario: string; status: "seeding" | "ready" | "failed"; workspaceReady?: boolean; baselineQuoteVersion?: number; busy: boolean; changeOrderId: string | null; stages: Stage[]; canResume: boolean; error: string | null };
type PreviousRun = { runId: string; status: Seed["status"]; createdAt: string };
type Snapshot = { seed: Seed | null; href: string; previousRuns: PreviousRun[]; hasWorkspace: boolean };
type Busy = "maple" | "resume" | "reload" | null;
type MapleRole = Extract<AccountId, "jordan" | "emma">;
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
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<MapleRole>("emma");
  const [confirmNew, setConfirmNew] = useState(false);
  const [opening, setOpening] = useState(false);
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

  // Back from the opened project, the page may come from the browser's cache still "opening".
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => { if (event.persisted) setOpening(false); };
    window.addEventListener("pageshow", shown);
    return () => window.removeEventListener("pageshow", shown);
  }, []);

  /** The browser is signed in as the chosen person of the run, then opens `path` fresh, read as them. */
  function enter(path: string, account: AccountId) {
    setOpening(true);
    void switchPersona(account, path).then((problem) => {
      if (problem && mounted.current) { setOpening(false); setError(problem); }
    });
  }

  function open(account: AccountId) {
    enter("/chats/maple", account);
  }

  async function post(body: object, signal: AbortSignal): Promise<Snapshot> {
    const response = await fetch("/api/try", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    const result: unknown = await response.json().catch(() => null);
    if (isSnapshot(result) && !signal.aborted) {
      expectedRun.current = result.seed?.runId ?? null;
      accept(result);
      announceTryProgress(result.seed);
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
      if (canOpenPreparedWorkspace(run)) return current;
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

  function startMaple(account: MapleRole, restart = false) {
    if (working.current) return;
    setRole(account);
    if (!restart && seed?.scenario === HOME_SCENARIO && canOpenPreparedWorkspace(seed)) return open(account);
    void perform("maple", async (signal) => {
      const initial = !restart && seed?.scenario === HOME_SCENARIO ? snapshot! : await post({ action: "start", scenario: HOME_SCENARIO, ...(restart ? { restart: true } : {}) }, signal);
      if (restart && seed && initial.seed?.runId === seed.runId) throw new Error("This run is still being prepared. Continue its saved preparation before creating a separate run.");
      if (initial.seed?.scenario !== HOME_SCENARIO) throw new Error("Your earlier project is still being prepared. Continue its saved preparation below before opening the new café example.");
      const ready = initial.seed && canOpenPreparedWorkspace(initial.seed) ? initial : await prepare(initial, signal);
      if (!signal.aborted && mounted.current && ready) open(account);
    });
  }
  /** The studio belongs to the demo's designer, so a visitor without a demo starts one first; no money is prepared for it. */
  function openStudio() {
    if (working.current) return;
    setRole("jordan");
    if (snapshot?.hasWorkspace) return enter("/studio", "jordan");
    void perform("maple", async (signal) => {
      await post({ action: "start", scenario: HOME_SCENARIO }, signal);
      if (!signal.aborted && mounted.current) enter("/studio", "jordan");
    });
  }
  function resume(runId: string, account: MapleRole) {
    if (working.current) return;
    setRole(account);
    void perform("resume", async (signal) => {
      const selected = await post({ action: "resume", runId }, signal);
      const ready = selected.seed && canOpenPreparedWorkspace(selected.seed) ? selected : await prepare(selected, signal);
      if (!signal.aborted && mounted.current && ready) open(account);
    });
  }

  const disabled = checking || busy !== null || opening;
  const preparing = busy === "maple" || busy === "resume";
  const savedStages = seed?.stages.filter((stage) => stage.status === "done").length ?? 0;

  return <main className={styles.page}>
    <section className={styles.hero} aria-labelledby="try-title">
      <Image src="/images/try-living-room.webp" alt="" fill priority sizes="100vw" className={styles.heroImage} />
      <div className={styles.shade} />
      <header className={styles.header}>
        <Link href="/try" aria-label="Setti home" className={styles.wordmark}>setti<span aria-hidden="true">.</span></Link>
        <div className={styles.headerActions}>
          <span className={styles.sandbox}>PayPal Sandbox<span>No real money</span></span>
          {snapshot?.hasWorkspace && <EndDemoButton className={styles.endDemo} />}
        </div>
      </header>

      <div className={styles.intro}>
        <h1 id="try-title">Your project.<br />On the same page.</h1>
        <p className={styles.description}>A shared space for interior design changes,<br className={styles.desktopBreak} /> approvals and payments.</p>
        <div className={styles.roles} role="group" aria-label="Choose your role">
          <div className={styles.role}>
            <button type="button" className={styles.designerButton} disabled={busy !== null || opening} onClick={openStudio}>
              I&rsquo;m a designer
              {(preparing || opening) && role === "jordan" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
            </button>
            <span>Explore the studio&rsquo;s projects &amp; changes</span>
          </div>
          <div className={styles.role}>
            <button type="button" className={styles.clientButton} disabled={disabled} onClick={() => startMaple("emma")}>
              I&rsquo;m a client
              {(preparing || opening) && role === "emma" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ArrowRight aria-hidden="true" />}
            </button>
            <span>Discuss ideas &amp; approve the details</span>
          </div>
        </div>
        <p className={styles.entryStatus} role="status" aria-live="polite">
          {checking ? "Finding your saved project…" : error ? <>Your project couldn&rsquo;t open. <a href="#try-problem">See what needs attention.</a></> : opening ? "Opening your project…" : preparing ? seed?.scenario === HOME_SCENARIO ? "Opening your project. Test payments will continue in the background…" : `Preparing your project · ${savedStages} of ${seed?.stages.length ?? 10} steps saved` : seed?.scenario === HOME_SCENARIO && seed.workspaceReady ? "Your café project is ready to read. Choose a role to continue." : "A café counter refit, shared by designer and client. Switch roles anytime."}
        </p>
      </div>

      <div className={styles.heroFooter}>
        <span>Maple Ave Café<span className={styles.projectCaption}>A sample interior design project</span></span>
        <span className={styles.sharedProject}>Two roles. The same project.</span>
      </div>
    </section>

    <div className={styles.below}>
      {error && <div id="try-problem" role="alert" tabIndex={-1} className={styles.error}>
        <CircleAlert aria-hidden="true" />
        <div><p>{error}</p><p className={styles.note}>Your saved payment records are kept. Read-only examples are available below.</p>
          <button type="button" disabled={busy !== null} onClick={() => { void perform("reload", async (signal) => { await read(signal); }); }} className={styles.textButton}><RefreshCw aria-hidden="true" />Reload saved status</button>
        </div>
      </div>}

      {seed && <details id="try-preparation" className={styles.details} open={seed.status !== "ready"}>
        <summary><span>Your saved Maple preparation</span><span className={styles.summaryStatus}>{runStatus[seed.status]}</span><ChevronDown aria-hidden="true" /></summary>
        <div className={styles.detailContent}>
          <ol className={styles.stages} aria-label="Saved preparation progress">{seed.stages.map((stage) => <li key={stage.id} data-status={stage.status}>
            {stage.status === "done" ? <Check aria-hidden="true" /> : stage.status === "running" ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : stage.status === "failed" ? <CircleAlert aria-hidden="true" /> : <Clock3 aria-hidden="true" />}
            <span>{stage.label}<small>{stageStatus[stage.status]}</small></span>
          </li>)}</ol>
          <p className={styles.note}>You can leave and return to the same saved project and payment records.</p>
          {seed.error && <p className={styles.preparationError}>{seed.error}</p>}
          {seed.changeOrderId && seed.status !== "ready" && <button type="button" disabled={disabled} onClick={() => open(role)} className={styles.textButton}>View this run&rsquo;s saved project records<ArrowRight aria-hidden="true" /></button>}
          {!confirmNew ? <button type="button" disabled={disabled} onClick={() => setConfirmNew(true)} className={styles.newRun}>Start a separate Maple run</button> : <div className={styles.confirmNew}>
            <p>A separate run keeps this project in your history. It does not cancel its holds, refund payments or clear unknown outcomes.</p>
            <div className={styles.confirmActions}>
              <button type="button" disabled={disabled} onClick={() => startMaple("jordan", true)} className={styles.smallButton}>Create as designer<ArrowRight aria-hidden="true" /></button>
              <button type="button" disabled={disabled} onClick={() => startMaple("emma", true)} className={styles.smallButton}>Create as client<ArrowRight aria-hidden="true" /></button>
              <button type="button" disabled={disabled} onClick={() => setConfirmNew(false)} className={styles.textButton}>Keep this run</button>
            </div>
          </div>}
        </div>
      </details>}

      {!!snapshot?.previousRuns.length && <details className={styles.details}>
        <summary><span>Previous Maple runs</span><span className={styles.summaryStatus}>{snapshot.previousRuns.length} saved</span><ChevronDown aria-hidden="true" /></summary>
        <ul className={styles.history}>{snapshot.previousRuns.map((run) => <li key={run.runId}>
          <div><p>{savedOn(run.createdAt)}</p><span className={styles.note}>{runStatus[run.status]}</span></div>
          <div className={styles.historyActions}>
            <button type="button" disabled={disabled} onClick={() => resume(run.runId, "jordan")} className={styles.textButton}>Open as designer<ArrowRight aria-hidden="true" /></button>
            <button type="button" disabled={disabled} onClick={() => resume(run.runId, "emma")} className={styles.textButton}>Open as client<ArrowRight aria-hidden="true" /></button>
          </div>
        </li>)}</ul>
      </details>}

      <nav className={styles.more} aria-label="More ways to try Setti">
        <div><p>Just looking around?</p><Link href="/try/cases">Browse read-only examples<ArrowUpRight aria-hidden="true" /></Link></div>
      </nav>
      <footer className={styles.footer}>
        <span>Fictional projects. PayPal Sandbox payments only.</span>
        <a href="https://unsplash.com/photos/living-room-with-brown-sofa-and-glass-window-4_jQL4JCS98" target="_blank" rel="noreferrer">Photo by Collov Home Design</a>
      </footer>
    </div>
  </main>;
}
