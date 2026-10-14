import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/** Title on the left with an optional parent link and one-line description; page actions on the right. */
export function PageHeader({ title, subtitle, parent, actions, className }: {
  title: ReactNode; subtitle?: ReactNode; parent?: { label: string; href: string }; actions?: ReactNode; className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0">
        {parent && (
          <Link href={parent.href} className="mb-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"><ChevronLeft className="size-3.5" />{parent.label}</Link>
        )}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
