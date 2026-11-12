"use client";

import { Download, LoaderCircle, Printer } from "lucide-react";
import { BackToChat } from "../BackToChat";
import { ReceiptDocument } from "./ReceiptDocument";
import { receiptSource, useVersionReceipt } from "./useVersionReceipt";

/** On paper each sheet is one A4 page; the sheets carry their own margins and footers. */
function PrintRules() {
  // The app paints the page body; on paper only the document is printed.
  return <style>{"@page { size: A4; margin: 0; } @media print { html, body { background: #fff !important; } }"}</style>;
}

/**
 * A version's formal document on its own page: the quote as sent while the
 * client has not signed it, the signed version receipt after. Shown as A4
 * sheets with page numbers, printed as the same A4 pages.
 */
export function ReceiptPage({ projectKey, version, studioName }: { projectKey: string; version: string; studioName: string }) {
  const loaded = useVersionReceipt(projectKey, version);
  const source = receiptSource(projectKey, version);
  const receipt = loaded && "receipt" in loaded ? loaded.receipt : null;
  return <div className="min-h-dvh bg-[#e7e5de] px-3 py-5 text-[var(--ink)] sm:px-6 print:min-h-0 print:bg-white print:p-0">
    <main className="mx-auto grid max-w-[210mm] gap-4 print:block print:max-w-none">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[#d6d3c8] bg-[#fbfaf7] px-3 py-2 print:hidden">
        <BackToChat projectKey={projectKey} />
        {receipt && <span className="font-mono text-[11px] text-[var(--muted)]">No. {receipt.receiptNo}</span>}
        {receipt && <div className="ml-auto flex flex-wrap gap-2">
          <button type="button" onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg border border-[#d6d3c8] bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]"><Printer aria-hidden className="h-3.5 w-3.5" />Print or save as PDF</button>
          <a href={`${source}?download=1`} className="flex items-center gap-1.5 rounded-lg border border-[#d6d3c8] bg-white px-3 py-1.5 text-[12px] font-medium hover:bg-[var(--canvas)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-fill)]"><Download aria-hidden className="h-3.5 w-3.5" />Download record (JSON)</a>
        </div>}
      </div>
      {!loaded && <p role="status" className="flex items-center gap-2 rounded-xl bg-white p-8 text-[13px] text-[var(--muted)] print:hidden"><LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" />Loading the document…</p>}
      {loaded && "error" in loaded && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-[12px] text-red-800">{loaded.error}</p>}
      {receipt && <><PrintRules /><ReceiptDocument receipt={receipt} studioName={studioName} /></>}
    </main>
  </div>;
}
