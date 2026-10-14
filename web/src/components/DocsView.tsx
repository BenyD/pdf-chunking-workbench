"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

type Heading = { level: 2 | 3; text: string; id: string };

const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const textOf = (n: ReactNode): string => Array.isArray(n) ? n.map(textOf).join("") : typeof n === "string" || typeof n === "number" ? String(n) : n && typeof n === "object" && "props" in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : "";

/** Documentation layout: sticky section nav on the left, content filling the rest. */
export function DocsView({ markdown }: { markdown: string }) {
  const headings = useMemo<Heading[]>(() => {
    const out: Heading[] = [];
    for (const line of markdown.split("\n")) {
      const m = /^(##|###)\s+(.+)$/.exec(line);
      if (m) out.push({ level: m[1].length as 2 | 3, text: m[2].trim(), id: slug(m[2]) });
    }
    return out;
  }, [markdown]);
  const [active, setActive] = useState<string>(headings[0]?.id ?? "");

  useEffect(() => {
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    if (!els.length) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [headings]);

  const sections = headings.filter((h) => h.level === 2);
  const activeSection = headings.find((h) => h.id === active)?.level === 3
    ? headings.slice(0, headings.findIndex((h) => h.id === active)).reverse().find((h) => h.level === 2)?.id
    : active;

  return (
    <div className="lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10">
      {/* phone: scrolling chip row */}
      <nav className="scrollbar-none sticky top-14 z-20 -mx-4 mb-4 flex gap-1.5 overflow-x-auto bg-background/95 px-4 py-2 backdrop-blur lg:hidden">
        {sections.map((h) => (
          <a key={h.id} href={`#${h.id}`} className={cn("shrink-0 rounded-full px-3 py-1.5 text-sm ring-1 ring-inset", activeSection === h.id ? "bg-foreground text-background ring-foreground" : "bg-card text-muted-foreground ring-border")}>{h.text}</a>
        ))}
      </nav>
      {/* desktop: sticky side nav */}
      <aside className="hidden lg:block">
        <nav className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2">
          <div className="mb-2 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">On this page</div>
          <ul className="space-y-0.5 border-l">
            {headings.map((h) => (
              <li key={h.id}>
                <a href={`#${h.id}`} className={cn("-ml-px block border-l-2 py-1 text-sm transition-colors", h.level === 3 ? "pl-6" : "pl-3", active === h.id ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>{h.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <article className="prose-md min-w-0 max-w-none text-[15px] [&_h2]:scroll-mt-24 [&_h3]:scroll-mt-24">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="text-3xl font-semibold tracking-tight">{children}</h1>,
            h2: ({ children }) => <h2 id={slug(textOf(children))} className="mt-10 border-t pt-8 text-xl font-semibold tracking-tight first-of-type:mt-6 first-of-type:border-0 first-of-type:pt-0">{children}</h2>,
            h3: ({ children }) => <h3 id={slug(textOf(children))} className="mt-6 text-base font-semibold">{children}</h3>,
            table: ({ children }) => <div className="my-4 overflow-x-auto rounded-xl ring-1 ring-black/5"><table className="!my-0 w-full">{children}</table></div>,
          }}
        >
          {markdown}
        </ReactMarkdown>
      </article>
    </div>
  );
}
