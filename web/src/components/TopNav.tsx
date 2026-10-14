"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenText, FileText, FlaskConical, ScanText, Search } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Documents", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
  { href: "/ocr", label: "Zonal OCR", icon: ScanText },
  { href: "/eval", label: "Evaluation", icon: FlaskConical },
  { href: "/docs", label: "Documentation", icon: BookOpenText },
];

/** Slim top bar with the segmented navigation. Scrolls sideways on narrow screens. */
export function TopNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur">
      <div className="mx-auto max-w-[1440px] px-4 pt-3 pb-1 sm:px-6">
        <nav className="scrollbar-none -mx-1 flex overflow-x-auto px-1">
          <div className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-muted p-1 ring-1 ring-black/5">
            {NAV.map((n) => {
              const active = isActive(n.href);
              return (
                <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined}
                  className={cn("flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm whitespace-nowrap transition-colors", active ? "bg-foreground font-medium text-background shadow-sm" : "text-muted-foreground hover:bg-background/70 hover:text-foreground")}>
                  <n.icon className="size-4" strokeWidth={1.75} />
                  <span className={cn(!active && "hidden sm:inline")}>{n.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </div>
    </header>
  );
}
