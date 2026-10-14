"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BookOpenText, FileText, FlaskConical, Menu, ScanText, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Documents", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
  { href: "/ocr", label: "Zonal OCR", icon: ScanText },
  { href: "/eval", label: "Evaluation", icon: FlaskConical },
  { href: "/decisions", label: "Decisions", icon: BookOpenText },
];

export function TopNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  const current = NAV.find((n) => isActive(n.href)) ?? NAV[0];
  return (
    <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-4 sm:px-6">
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className={cn("flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors", isActive(n.href) ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>
              <n.icon className="size-4" />{n.label}
            </Link>
          ))}
        </nav>
        <span className="flex items-center gap-1.5 text-sm font-medium md:hidden"><current.icon className="size-4 text-primary" />{current.label}</span>
        <Button variant="ghost" size="icon" className="ml-auto md:hidden" aria-label="menu" onClick={() => setOpen((o) => !o)}>{open ? <X /> : <Menu />}</Button>
      </div>
      {open && (
        <nav className="border-t bg-background px-4 py-2 md:hidden">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={cn("flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm", isActive(n.href) ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground")}>
              <n.icon className="size-4" />{n.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
