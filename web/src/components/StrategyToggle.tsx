"use client";
import { STRATEGIES, type Strategy } from "@/lib/types";
import { STRATEGY_INFO } from "@/lib/ui";
import { cn } from "@/lib/utils";

/** Single choice, segmented pill. */
export function StrategyTabs({ value, onChange, className }: { value: Strategy; onChange: (s: Strategy) => void; className?: string }) {
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-full bg-muted p-1", className)} role="tablist">
      {STRATEGIES.map((s) => (
        <button key={s} type="button" role="tab" aria-selected={value === s} title={STRATEGY_INFO[s].blurb} onClick={() => onChange(s)}
          className={cn("rounded-full px-3.5 py-1.5 text-sm transition-colors", value === s ? "bg-foreground font-medium text-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
          {STRATEGY_INFO[s].label}
        </button>
      ))}
    </div>
  );
}

/** Multiple choice, pill chips. At least one stays on. */
export function StrategyMulti({ selected, onChange, className }: { selected: Strategy[]; onChange: (s: Strategy[]) => void; className?: string }) {
  const toggle = (s: Strategy) => {
    const next = selected.includes(s) ? selected.filter((x) => x !== s) : [...selected, s];
    if (next.length) onChange(STRATEGIES.filter((x) => next.includes(x)));
  };
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {STRATEGIES.map((s) => {
        const on = selected.includes(s);
        return (
          <button key={s} type="button" aria-pressed={on} title={STRATEGY_INFO[s].blurb} onClick={() => toggle(s)}
            className={cn("rounded-full px-3 py-1.5 text-sm ring-1 ring-inset transition-colors", on ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border hover:text-foreground")}>
            {STRATEGY_INFO[s].label}
          </button>
        );
      })}
    </div>
  );
}
