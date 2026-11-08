/** Hand-drawn line art for the landing page: furniture and the designer, in one ink stroke style. */
type DoodleProps = { className?: string; width?: number };

function Ink({ viewBox, className, width, children }: DoodleProps & { viewBox: string; children: React.ReactNode }) {
  return (
    <svg viewBox={viewBox} width={width} className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function SofaDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 140 92" {...props}>
      <path d="M22 42c0-10 6-16 16-16h64c10 0 16 6 16 16v6" />
      <path d="M12 52c0-6 4-10 10-10s10 4 10 10v13h76V52c0-6 4-10 10-10s10 4 10 10v17c0 4-3 7-7 7H19c-4 0-7-3-7-7z" />
      <path d="M32 65v-7c0-4 3-6 6-6h64c3 0 6 2 6 6v7" />
      <path d="M24 76l-3 10M116 76l3 10" />
    </Ink>
  );
}

export function LampDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 60 130" {...props}>
      <path d="M16 8h28l12 30H4z" /><path d="M30 38v84" /><path d="M14 124h32" />
    </Ink>
  );
}

export function PlantDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 70 110" {...props}>
      <path d="M20 70h30l-5 34H25z" />
      <path d="M35 70C35 48 26 32 10 26c16 0 26 12 25 44" />
      <path d="M35 70c0-24 9-40 26-46-7 16-14 27-26 46" />
      <path d="M35 66c-2-24 0-38 5-50" />
    </Ink>
  );
}

export function TableDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 120 100" {...props}>
      <ellipse cx="60" cy="38" rx="40" ry="10" /><path d="M60 48v40M44 92h32" />
    </Ink>
  );
}

/** The designer, holding a sample board. */
export function DesignerDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 110 150" {...props}>
      <circle cx="48" cy="32" r="17" />
      <path d="M31 30c2-16 30-20 35-2 4-2 7 2 5 6" />
      <circle cx="42" cy="34" r="1.5" fill="currentColor" /><circle cx="54" cy="34" r="1.5" fill="currentColor" />
      <path d="M43 41c3 2 7 2 10 0" />
      <path d="M26 146V88c0-14 10-24 22-24s22 10 22 24v58" />
      <path d="M28 94l-14 26 22 8" /><path d="M68 92l18 18" />
      <rect x="80" y="104" width="24" height="32" rx="2" /><path d="M86 114h12M86 121h12M86 128h7" />
    </Ink>
  );
}

export function ReceiptDoodle(props: DoodleProps) {
  return (
    <Ink viewBox="0 0 70 100" {...props}>
      <path d="M10 6h50v86l-8-6-8 6-9-6-8 6-9-6-8 6z" /><path d="M20 26h30M20 38h30M20 50h18" /><path d="M22 66l7 7 14-14" />
    </Ink>
  );
}

/* Small step icons, drawn in the same stroke. */
export function ChatIcon(props: DoodleProps) {
  return <Ink viewBox="0 0 32 32" {...props}><path d="M5 7h22v14H14l-6 5v-5H5z" /><path d="M10 12h12M10 16h8" /></Ink>;
}
export function SparkIcon(props: DoodleProps) {
  return <Ink viewBox="0 0 32 32" {...props}><path d="M16 4l2.6 7.4L26 14l-7.4 2.6L16 24l-2.6-7.4L6 14l7.4-2.6z" /><path d="M25 22l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" /></Ink>;
}
export function SignIcon(props: DoodleProps) {
  return <Ink viewBox="0 0 32 32" {...props}><path d="M5 25c4-1 6-6 9-6s1 5 4 5 4-4 6-4 2 2 3 2" /><path d="M20 5l7 7-11 11H9v-7z" /></Ink>;
}
export function CardIcon(props: DoodleProps) {
  return <Ink viewBox="0 0 32 32" {...props}><rect x="4" y="8" width="24" height="17" rx="3" /><path d="M4 13h24M9 20h5" /></Ink>;
}
