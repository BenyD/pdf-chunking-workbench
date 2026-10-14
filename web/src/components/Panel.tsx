import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Soft outer surface with an inner white card. The title sits on the outer
 * surface; content sits on the inner card. Use it for every main block.
 */
export function Panel({ title, icon, description, action, children, className, bodyClassName }: {
  title?: ReactNode; icon?: ReactNode; description?: ReactNode; action?: ReactNode;
  children: ReactNode; className?: string; bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-[1.75rem] bg-muted/80 p-1.5", className)}>
      {(title || action) && (
        <div className="flex items-start justify-between gap-3 px-3.5 pt-2.5 pb-2">
          <div className="min-w-0">
            {title && <h2 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">{icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn("rounded-[1.25rem] bg-card p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)]", bodyClassName)}>{children}</div>
    </section>
  );
}
