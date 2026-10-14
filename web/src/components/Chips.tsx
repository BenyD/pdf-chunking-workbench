import { AlertCircle, AlignLeft, CheckCircle2, Clock, FileSpreadsheet, Image as ImageIcon, Rows3, Table2, Upload } from "lucide-react";
import type { ChunkType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Donut } from "./Donut";

/** Pill: soft tint, matching text, hairline ring, icon first. */
const pill = "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium leading-4 whitespace-nowrap ring-1 ring-inset";

export const TONES = {
  gray:    "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-800 dark:text-zinc-200 dark:ring-zinc-700",
  blue:    "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:ring-sky-900",
  green:   "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-900",
  amber:   "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-900",
  orange:  "bg-orange-50 text-orange-600 ring-orange-200 dark:bg-orange-950 dark:text-orange-200 dark:ring-orange-900",
  red:     "bg-red-50 text-red-700 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-900",
  purple:  "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-200 dark:ring-fuchsia-900",
  teal:    "bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-950 dark:text-teal-200 dark:ring-teal-900",
  navy:    "bg-slate-100 text-slate-800 ring-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700",
} as const;

export function Pill({ tone = "gray", icon, children, className }: { tone?: keyof typeof TONES; icon?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <span className={cn(pill, TONES[tone], className)}>{icon && <span className="[&_svg]:size-3.5">{icon}</span>}{children}</span>;
}

const TYPE: Record<ChunkType, { tone: keyof typeof TONES; icon: React.ReactNode; label: string }> = {
  text:      { tone: "blue",   icon: <AlignLeft />, label: "Text" },
  table:     { tone: "amber",  icon: <Table2 />, label: "Table" },
  table_row: { tone: "orange", icon: <Rows3 />, label: "Table row" },
  figure:    { tone: "purple", icon: <ImageIcon />, label: "Figure" },
  record:    { tone: "green",  icon: <FileSpreadsheet />, label: "Form" },
};

export function TypeChip({ type, count, className }: { type: ChunkType; count?: number; className?: string }) {
  const t = TYPE[type] ?? TYPE.text;
  return <Pill tone={t.tone} icon={t.icon} className={className}>{count !== undefined ? `${count.toLocaleString()} ` : ""}{t.label}</Pill>;
}

export function StatusBadge({ status, detail, progress }: { status: string; detail?: string; progress?: number | null }) {
  if (status === "ready") return <Pill tone="green" icon={<CheckCircle2 />}>Ready</Pill>;
  if (status === "error") return <Pill tone="red" icon={<AlertCircle />}>Failed</Pill>;
  if (status === "processing") return <Pill tone="orange" icon={<Donut value={progress} size={14} stroke={2.4} />}>{detail ?? "Processing"}</Pill>;
  if (status === "uploading") return <Pill tone="blue" icon={<Upload />}>Uploading</Pill>;
  return <Pill tone="gray" icon={<Clock />}>Queued</Pill>;
}
