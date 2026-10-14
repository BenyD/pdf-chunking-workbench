"use client";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { STRATEGIES, type Strategy } from "@/lib/types";
import { STRATEGY_INFO } from "@/lib/ui";

/** Single choice: which strategy to display. */
export function StrategyTabs({ value, onChange }: { value: Strategy; onChange: (s: Strategy) => void }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as Strategy)}>
      <TabsList>
        {STRATEGIES.map((s) => <TabsTrigger key={s} value={s} title={STRATEGY_INFO[s].blurb}>{STRATEGY_INFO[s].label}</TabsTrigger>)}
      </TabsList>
    </Tabs>
  );
}

/** Multiple choice: which strategies to compare. At least one stays on. */
export function StrategyMulti({ selected, onChange }: { selected: Strategy[]; onChange: (s: Strategy[]) => void }) {
  return (
    <ToggleGroup multiple variant="outline" spacing={0} value={selected} onValueChange={(v) => { const next = (v as Strategy[]).filter((x) => STRATEGIES.includes(x)); if (next.length) onChange(STRATEGIES.filter((s) => next.includes(s))); }}>
      {STRATEGIES.map((s) => <ToggleGroupItem key={s} value={s} title={STRATEGY_INFO[s].blurb}>{STRATEGY_INFO[s].label}</ToggleGroupItem>)}
    </ToggleGroup>
  );
}
