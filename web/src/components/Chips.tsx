import { AlertCircle, AlignLeft, BookText, CheckCircle2, Clock, FileSpreadsheet, Grid2x2, Image as ImageIcon, ListTree, Loader2, Rows3, Table2, Upload } from "lucide-react";
import type { ChunkType, Strategy } from "@/lib/types";
import { STRATEGY_INFO, TYPE_STYLE } from "@/lib/ui";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<ChunkType, React.ComponentType<{ className?: string }>> = {
  text: AlignLeft, table: Table2, table_row: Rows3, figure: ImageIcon, record: FileSpreadsheet,
};
const STRATEGY_ICON: Record<Strategy, React.ComponentType<{ className?: string }>> = {
  naive: Grid2x2, structural: ListTree, contextual: BookText,
};

const base = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap";

/** Chunk type pill. With `count`, reads "8 text". */
export function TypeChip({ type, count, className }: { type: ChunkType; count?: number; className?: string }) {
  const s = TYPE_STYLE[type] ?? TYPE_STYLE.text;
  const Icon = TYPE_ICON[type] ?? AlignLeft;
  return (
    <span className={cn(base, s.chip, className)}>
      <Icon className="size-3" />{count !== undefined ? `${count.toLocaleString()} ` : ""}{s.label}
    </span>
  );
}

export function StrategyChip({ strategy, className }: { strategy: Strategy; className?: string }) {
  const Icon = STRATEGY_ICON[strategy];
  return (
    <span className={cn(base, "border-transparent", STRATEGY_INFO[strategy].chip, className)}>
      <Icon className="size-3" />{STRATEGY_INFO[strategy].label}
    </span>
  );
}

export function StatusBadge({ status, detail }: { status: string; detail?: string }) {
  const map: Record<string, { icon: React.ReactNode; cls: string; label: string }> = {
    ready: { icon: <CheckCircle2 className="size-3" />, cls: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200", label: "Ready" },
    error: { icon: <AlertCircle className="size-3" />, cls: "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200", label: "Failed" },
    processing: { icon: <Loader2 className="size-3 animate-spin" />, cls: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200", label: "Processing" },
    queued: { icon: <Clock className="size-3" />, cls: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200", label: "Queued" },
    uploading: { icon: <Upload className="size-3" />, cls: "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200", label: "Uploading" },
  };
  const m = map[status] ?? map.queued;
  return <span className={cn(base, m.cls)}>{m.icon}{m.label}{detail ? <span className="font-normal opacity-80">{detail}</span> : null}</span>;
}
