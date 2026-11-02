import { FileText } from "lucide-react";
import { HOME_SUPPLIER_NOTES } from "@/demo/living-dining";

const ITEM_NAMES: Record<string, string> = {
  sofa: "Sofa", "coffee-table": "Coffee table", "dining-table": "Dining table", "dining-chairs": "Dining chairs", sideboard: "Sideboard", design: "Design service",
};

/** Shorter names for the notes' line labels. */
const LABELS: Record<string, string> = { Alternative: "Proposed alternative", "Handling and returns": "Returns", "Fictional starting-history condition": "Starting history" };

interface SupplierDocument { reference: string; itemId: string; supplier: string; rows: { label: string; text: string }[] }

/**
 * The notes are one text, the same the model reads: an introduction, then one
 * block per supplier document headed `[REFERENCE] itemId=… | Supplier`, then a
 * closing note. Each document line starts with its label ("Original: …").
 */
export function parseSupplierNotes(text: string): { intro: string[]; documents: SupplierDocument[]; outro: string[] } | null {
  const blocks = text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const documents: SupplierDocument[] = [];
  const intro: string[] = [], outro: string[] = [];
  for (const block of blocks) {
    const [head, ...lines] = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const match = /^\[([^\]]+)\]\s*itemId=([\w-]+)\s*\|\s*(.+)$/.exec(head);
    // An all-capital title line is the notes' heading, already shown as the summary.
    if (!match) { (documents.length ? outro : intro).push([head, ...lines].filter((line) => line !== line.toUpperCase()).join(" ")); continue; }
    documents.push({
      reference: match[1], itemId: match[2], supplier: match[3].replace(/\s*\(demo\)\s*$/, ""),
      rows: lines.map((line) => {
        const labelled = /^([A-Z][A-Za-z -]{2,40}):\s*(.+)$/.exec(line);
        return labelled ? { label: LABELS[labelled[1]] ?? labelled[1], text: labelled[2] } : { label: "Plan", text: line };
      }),
    });
  }
  return documents.length ? { intro, documents, outro } : null;
}

/** The same local example documents supplied to the model, laid out for a person to check. */
export function HomeSupplierDocuments({ id, highlighted = false, text = HOME_SUPPLIER_NOTES }: { id?: string; highlighted?: boolean; text?: string }) {
  const parsed = parseSupplierNotes(text);
  return <details id={id} open={highlighted || undefined} className={`rounded-xl border p-3.5 text-[12px] leading-relaxed ${highlighted ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-slate-50"}`}>
    <summary className="cursor-pointer font-semibold text-slate-800">Sample supplier documents <span className="ml-1 font-normal text-slate-500">· provided by Jordan{parsed ? ` · ${parsed.documents.length} documents` : ""}</span></summary>
    <p className="mt-3 text-[11px] text-slate-500">Fictional local materials for this walkthrough. The AI reads these same product quotes and return terms; they have not been uploaded or verified with a real supplier.</p>
    {!parsed ? <div className="mt-3 whitespace-pre-wrap break-words text-[11px] text-slate-600">{text}</div> : <>
      <div className="mt-3 grid gap-2.5 lg:grid-cols-2">{parsed.documents.map((document) => <article key={document.reference} className="rounded-lg border border-slate-200 bg-white p-3">
        <header className="flex items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-700"><FileText className="h-3.5 w-3.5" /></span>
          <div className="min-w-0 flex-1">
            <h4 className="text-[12px] font-semibold text-slate-800">{ITEM_NAMES[document.itemId] ?? document.itemId} <span className="font-normal text-slate-500">· {document.supplier}</span></h4>
            <p className="font-mono text-[10px] text-slate-400">{document.reference}</p>
          </div>
        </header>
        <dl className="mt-2 space-y-1.5">{document.rows.map((row, index) => <div key={index}>
          <dt className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{row.label}</dt>
          <dd className="break-words text-[11px] leading-relaxed text-slate-600">{row.text}</dd>
        </div>)}</dl>
      </article>)}</div>
      {[...parsed.intro, ...parsed.outro].length > 0 && <details className="mt-2.5 rounded-lg border border-slate-200 bg-white p-3 text-[11px] text-slate-500">
        <summary className="cursor-pointer font-medium text-slate-600">About these documents</summary>
        {[...parsed.intro, ...parsed.outro].map((paragraph, index) => <p key={index} className="mt-2 break-words leading-relaxed">{paragraph}</p>)}
      </details>}
    </>}
  </details>;
}
