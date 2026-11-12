import { useId } from "react";

/**
 * Setti's mark: two versions of a quote, one over the other. The outline is the
 * agreed version, the solid square the new one, and their overlap, in amber, is
 * the difference Setti settles.
 */
export function BrandMark({ className = "h-9 w-9", title }: { className?: string; title?: string }) {
  const clip = useId();
  return <svg viewBox="0 0 48 48" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
    {title && <title>{title}</title>}
    <defs><clipPath id={clip}><rect x="6" y="6" width="25" height="25" rx="7" /></clipPath></defs>
    <rect x="6" y="6" width="25" height="25" rx="7" fill="none" stroke="#30362d" strokeWidth="3.4" />
    <rect x="17" y="17" width="25" height="25" rx="7" fill="#30362d" />
    <rect x="17" y="17" width="25" height="25" rx="7" fill="#f3b951" clipPath={`url(#${clip})`} />
  </svg>;
}
