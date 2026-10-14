import { cn } from "@/lib/utils";

/** A tiny circular progress indicator. Without a value it spins as an indeterminate arc. */
export function Donut({ value, size = 12, stroke = 2, className }: { value?: number | null; size?: number; stroke?: number; className?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn("shrink-0", pct == null && "animate-spin", className)} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="opacity-25" />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={pct == null ? c * 0.7 : c * (1 - pct / 100)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`} className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}
