"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenText, ChevronRight, FileText, FlaskConical, ScanText, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHeaderCrumbs } from "./HeaderContext";

const NAV = [
  { href: "/", label: "Documents", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
  { href: "/ocr", label: "Zonal OCR", icon: ScanText },
  { href: "/eval", label: "Evaluation", icon: FlaskConical },
  { href: "/docs", label: "Documentation", icon: BookOpenText },
];

/** Header: breadcrumb on the left, segmented navigation on the right. */
export function TopNav() {
  const pathname = usePathname();
  const { crumbs } = useHeaderCrumbs();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  const current = NAV.find((n) => isActive(n.href)) ?? NAV[0];
  const trail = crumbs ?? [{ label: current.label }];
  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 pt-3 pb-2 sm:px-6 md:h-16 md:flex-row md:items-center md:justify-between md:pt-0 md:pb-0">
        <nav aria-label="breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
          {trail.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
              {c.href ? <Link href={c.href} className="shrink-0 text-muted-foreground hover:text-foreground">{c.label}</Link> : <span className={cn("truncate", i === trail.length - 1 ? "font-medium text-foreground" : "text-muted-foreground")}>{c.label}</span>}
            </span>
          ))}
        </nav>
        <div className="scrollbar-none -mx-1 flex overflow-x-auto px-1">
          <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-1 ring-1 ring-black/5">
            {NAV.map((n) => {
              const active = isActive(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors", active ? "bg-foreground font-medium text-background shadow-sm" : "text-muted-foreground hover:bg-background/70 hover:text-foreground")}>
                  <n.icon className="size-4" strokeWidth={1.75} />
                  <span className={cn(!active && "hidden lg:inline")}>{n.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </header>
  );
}
