import { HOME_SUPPLIER_NOTES } from "@/demo/living-dining";

/** The same local example documents supplied to the model, available for human review. */
export function HomeSupplierDocuments({ id, highlighted = false, text = HOME_SUPPLIER_NOTES }: { id?: string; highlighted?: boolean; text?: string }) {
  return <details id={id} open={highlighted || undefined} className={`rounded-xl border p-3.5 text-[12px] leading-relaxed ${highlighted ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-slate-50"}`}>
    <summary className="cursor-pointer font-semibold text-slate-800">Sample supplier documents <span className="ml-1 font-normal text-slate-500">· provided by Jordan</span></summary>
    <p className="mt-3 text-[11px] text-slate-500">Fictional local materials for this walkthrough. The AI reads these same product quotes and return terms; they have not been uploaded or verified with a real supplier.</p>
    <div className="mt-3 whitespace-pre-wrap break-words text-[11px] text-slate-600">{text}</div>
  </details>;
}
