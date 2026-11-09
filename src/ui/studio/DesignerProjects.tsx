"use client";

import { ArrowRight, ArrowUpRight, Building2, CheckCircle2, ClipboardList, Coffee, FolderOpen, Home, Scissors, Search, Store, Truck, UtensilsCrossed } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { STUDIO_CASES } from "@/demo/studio-cases";
import { STUDIO_STAGES, studioQuoteTotal, type StudioIndustry } from "@/demo/studio-types";
import { OpenLiveProject } from "./OpenLiveProject";
import styles from "./Studio.module.css";

export const industryIcons = { Restaurant: UtensilsCrossed, "Coffee shop": Coffee, Retail: Store, Residential: Home, Office: Building2, Salon: Scissors };
const dollars = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);

export function DesignerProjects({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [filter, setFilter] = useState<"all" | "attention" | "settled">("all");
  const [search, setSearch] = useState("");
  const projects = STUDIO_CASES.filter((project) => (filter === "all" || (filter === "settled" ? project.stage === "settled" : project.stage !== "settled"))
    && `${project.name} ${project.industry} ${project.focus.join(" ")} ${project.client.name}`.toLowerCase().includes(search.trim().toLowerCase()));

  const overview = [
    { label: "Prepared projects", value: STUDIO_CASES.length, icon: FolderOpen },
    { label: "Client review", value: STUDIO_CASES.filter((project) => project.stage === "awaiting_client").length, icon: ClipboardList },
    { label: "Supplier follow-up", value: STUDIO_CASES.filter((project) => project.stage === "awaiting_supplier" || project.stage === "awaiting_credit").length, icon: Truck },
    { label: "Settled", value: STUDIO_CASES.filter((project) => project.stage === "settled").length, icon: CheckCircle2 },
  ];

  return <main className={styles.module} aria-label="Project management">
    <header className={styles.moduleHeader}><div><h1>Projects</h1><p>Progress, next steps and budgets across the studio.</p></div><Link href="/try" className={styles.headerLink}>Demo home<ArrowUpRight size={13} /></Link></header>
    <div className={styles.scrollArea}>
      <section className={styles.overview} aria-label="Prepared project overview">{overview.map(({ label, value, icon: StatIcon }) => <div key={label}><span><StatIcon size={16} />{label}</span><strong>{value}</strong></div>)}</section>

      <section className={styles.live} aria-labelledby="live-title">
        <div className={styles.liveIntro}><span className={styles.liveTag}>Interactive project</span><h2 id="live-title">Maple Ave Café · counter &amp; back bar</h2><p>Your working project for AI drafts, client approval and PayPal Sandbox payments.</p></div>
        <div className={styles.liveAction}><OpenLiveProject className={styles.primaryButton} /><p>No real money. The original quote opens first; payment preparation continues in the background.</p></div>
      </section>

      <section aria-labelledby="prepared-title">
        <div className={styles.sectionHeading}><div><h2 id="prepared-title">Project overview</h2><p>Open a project to review its conversation, quote and payment progress.</p></div><span className={styles.preparedTag}>Prepared histories</span></div>
        <div className={styles.toolbar}><div className={styles.filters} aria-label="Filter projects">{([['all', 'All projects'], ['attention', 'In progress'], ['settled', 'Settled']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}<span>{id === "all" ? STUDIO_CASES.length : STUDIO_CASES.filter((project) => id === "settled" ? project.stage === "settled" : project.stage !== "settled").length}</span></button>)}</div><label className={styles.search}><Search size={15} /><input aria-label="Search studio projects" placeholder="Search projects or materials" value={search} onChange={(event) => setSearch(event.target.value)} /></label></div>
        <div className={styles.grid}>{projects.map((project) => {
          const Icon = industryIcons[project.industry as StudioIndustry];
          const stage = STUDIO_STAGES[project.stage];
          const displayedQuote = project.proposal?.status === "awaiting_client" ? project.proposal : project.quote;
          return <Link key={project.id} href={`/chats/${project.id}`} className={styles.card} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenProject(project.id); }}>
            <div className={styles.cardTop}><span className={styles.industryIcon}><Icon size={21} strokeWidth={1.6} /></span><span className={styles.status} data-tone={stage.tone}>{stage.label}</span></div>
            <p className={styles.industry}>{project.industry}</p><h3>{project.name}</h3><p className={styles.summary}>{project.summary}</p>
            <div className={styles.materials}>{project.focus.map((focus) => <span key={focus}>{focus}</span>)}</div>
            <div className={styles.cardBudget}><span>{displayedQuote.status === "draft" ? "Draft" : displayedQuote.status === "awaiting_client" ? "Proposed" : "Approved"} V{displayedQuote.version}<strong>{dollars(studioQuoteTotal(displayedQuote))}</strong></span><span>{project.client.name}<small>{project.client.title}</small></span></div>
            <div className={styles.cardNext}><span>{project.next.title}</span><ArrowRight size={15} /></div>
          </Link>;
        })}</div>
        {!projects.length && <p role="status" className={styles.empty}>No projects match that search. Try a material, business type or client name.</p>}
        <p className={styles.disclosure}>Each project opens its own conversation. Continue in-progress projects with real AI; settled projects stay read only. Starting quotes, approvals and payment figures are prepared examples. Maple Ave Café includes the PayPal Sandbox walkthrough.</p>
      </section>
    </div>
  </main>;
}
