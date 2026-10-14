"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/quartz/ui/button";

const NAV = [
  { href: "/", label: "Documents" },
  { href: "/search", label: "Search" },
  { href: "/forms", label: "Forms" },
];

/** The top bar: the three places in the app. A page's title lives in its PageHeader, never here. */
export function TopNav() {
  const pathname = usePathname();
  const isActive = (href: string) => (href === "/" ? pathname === "/" || pathname.startsWith("/documents") : pathname.startsWith(href));
  return (
    <header className="sticky top-0 z-10 flex h-(--topbar) shrink-0 items-center gap-2 bg-page px-(--gutter-sm) sm:px-(--gutter)">
      <nav aria-label="Main" className="flex items-center gap-1">
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
