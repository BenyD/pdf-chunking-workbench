import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A calm, centred empty state: icon, one-line title, one-line hint, actions. */
export function EmptyState({ icon, title, hint, children, className }: {
  icon: ReactNode; title: string; hint?: string; children?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center", className)}>
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-6">{icon}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {hint && <p className="mt-1 max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {children && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div>}
    </div>
  );
}
