"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Documents" },
  { href: "/search", label: "Search" },
  { href: "/ocr", label: "Zonal OCR" },
  { href: "/eval", label: "Evaluation" },
  { href: "/docs", label: "Documentation" },
];

/** Segmented pill navigation. Scrolls sideways on narrow screens. */
export function TopNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-30 bg-background/90 backdrop-blur">
      <div className="mx-auto max-w-6xl px-4 pt-4 pb-2 sm:px-6">
        <nav className="scrollbar-none -mx-1 flex overflow-x-auto px-1">
          <div className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted p-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={cn("rounded-full px-4 py-1.5 text-sm whitespace-nowrap transition-colors", isActive(n.href) ? "bg-foreground font-medium text-background shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {n.label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </header>
  );
}
