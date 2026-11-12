"use client";

import { useCallback, useEffect, useState } from "react";
import type { CaseKey } from "@/chat/types";
import type { ServicesPaymentView } from "@/payments/services-view";
import { BrandMark } from "../BrandMark";
import { CARD, ModuleTitle } from "../pricing/EditorFrame";
import { SavedMethodCard, savedMethodName } from "../payments/PaymentMethods";

const small = "text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--muted)]";

/**
 * Project info on a sent version, for the designer and the client alike: the
 * studio on the left, the project and the other person on the right. The
 * client also sees the payment method saved for the project, and can manage it
 * here: PayPal deletes a removed method first.
 */
export function ViewProjectInfo({ projectKey, client, studioName, designerName, clientName, projectName, version }: {
  projectKey: CaseKey; client: boolean; studioName: string; designerName: string; clientName: string; projectName: string; version: number;
}) {
  const [open, setOpen] = useState(true);
  const [manage, setManage] = useState(false);
  const [payment, setPayment] = useState<ServicesPaymentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const designer = designerName.replace(/\s*\(demo designer\)$/, "");
  const studio = studioName || designer;

  const load = useCallback(async () => {
    const response = await fetch(`/api/quotes/${projectKey}/services-payment`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) setPayment(await response.json() as ServicesPaymentView);
  }, [projectKey]);
  useEffect(() => { if (client) void load(); }, [client, load]);

  async function remove() {
    setBusy(true); setError(null);
    const response = await fetch(`/api/quotes/${projectKey}/services-payment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "remove_saved" }) }).catch(() => null);
    setBusy(false);
    if (!response?.ok) { setError("The payment method could not be removed. Try again."); return; }
    await load();
  }

  const saved = payment?.savedMethod ?? null;
  return <section className={CARD} aria-label="Project info">
    <div className={`flex flex-wrap items-center gap-2.5 px-4 py-[11px] ${open ? "border-b border-[var(--line)]" : ""}`}>
      <ModuleTitle open={open} onToggle={() => setOpen((value) => !value)}>Project info</ModuleTitle>
      {!open && <span className="text-[12px] text-[var(--muted)]">{projectName} · {studio} · Quote V{version}</span>}
    </div>
    {open && <>
      <div className="grid sm:grid-cols-2">
        <div className="grid grid-cols-[44px_minmax(0,1fr)] content-start items-center gap-x-3 gap-y-0.5 px-4 py-3.5">
          <BrandMark className="row-span-3 h-11 w-11" />
          <b className="text-[14px] font-bold">{studio}</b>
          <span className="text-[12.5px]">{designer} · {client ? "Your designer" : "Designer"}</span>
          <span className="text-[12.5px] text-[var(--muted)]">{client ? `Message ${designer.split(" ")[0] || "your designer"} in the project chat` : "Studio details from Settings"}</span>
        </div>
        <div className="grid content-start gap-0.5 border-t border-[var(--line)] px-4 py-3.5 sm:border-l sm:border-t-0">
          <small className={small}>{client ? "Your project" : "Client"}</small>
          <b className="text-[13.5px] font-bold">{client ? projectName : clientName}</b>
          <span className="text-[12.5px]">{client ? clientName : projectName}</span>
          <span className="text-[12.5px] text-[var(--muted)]">{!client ? "Signs in the project chat" : <>
            {saved ? `Pays with ${savedMethodName(saved)}` : "No payment method saved"} · <button type="button" onClick={() => setManage((value) => !value)} aria-expanded={manage} className="font-medium text-[var(--primary)] underline-offset-2 hover:underline">{manage ? "Close" : "Manage"}</button>
          </>}</span>
        </div>
      </div>
      {client && manage && <div className="border-t border-[var(--line)] px-4 py-3">
        {saved
          ? <SavedMethodCard method={saved} canRemove={!!payment?.canRemoveSaved} busy={busy} disabled={busy} onRemove={() => void remove()} />
          : <p className="text-[11.5px] text-[var(--muted)]">No payment method is saved for this project. You choose PayPal or a card the first time you pay, and can save it then.</p>}
        {error && <p role="alert" className="mt-2 text-[12px] text-red-700">{error}</p>}
      </div>}
    </>}
  </section>;
}
