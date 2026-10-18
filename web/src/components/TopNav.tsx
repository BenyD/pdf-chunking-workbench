"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/quartz/ui/button";
import { formsEnabled } from "@/lib/flags";

const NAV = [
  { href: "/", label: "Documents" },
  { href: "/search", label: "Search" },
  ...(formsEnabled ? [{ href: "/forms", label: "Forms" }] : []),
];

/** The top bar: the places in the app. A page's title lives in its PageHeader, never here. */
export function TopNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-10 flex min-h-(--topbar) shrink-0 items-center gap-2 bg-page px-(--gutter-sm) py-2 sm:h-(--topbar) sm:px-(--gutter) sm:py-0">
      {/* On a phone the places sit in a grid of equal buttons, two to a row so no label is cut;
          from sm up they sit in one row at their natural width. */}
      <nav aria-label="Main" className="grid w-full grid-cols-2 gap-1 sm:flex sm:w-auto sm:items-center">
        {NAV.map((n) => {
          const active = isActive(n.href);
          return (
            <Button key={n.href} variant={active ? "secondary" : "ghost"} size="sm" nativeButton={false} render={<Link href={n.href} aria-current={active ? "page" : undefined} />}>
              {n.label}
            </Button>
          );
        })}
      </nav>
    </header>
  );
}
