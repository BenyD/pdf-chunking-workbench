'use client';

import {ButtonSize} from '@/components/quartz/ui/button';
import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {cva, type VariantProps} from 'class-variance-authority';
import {cn, mergeRefs} from '@/lib/quartz/utils';
import type {Kind} from '@/lib/quartz/kind';

// The top of a page: the title (with an optional kind label after it), one line of description, the page's actions, and a row of stats.
// The header is a container (@container), and its parts respond to the header's own width, not the
// viewport: title and actions share a row from 768px of header (@3xl), and below that the actions drop
// under the description.
//
// The considered detail is condense. With it on, when the title scrolls out of view a bar the height of the top bar slides
// in at the top of the scroll area holding the same title and the same actions, so "Create key" is
// never more than one reach away on a long page. The bar takes no space in the flow (a zero-height
// sticky), so nothing below it moves when it appears, and it is inert while hidden.

type Registry = {setTitle: (n: ReactNode) => void; setActions: (n: ReactNode) => void} | null;
const RegistryContext = createContext<Registry>(null);

const pageHeaderVariants = cva('group/page-header @container flex w-full flex-col', {
  variants: {
    size: {
      default: 'gap-6',
      sm: 'gap-4',
    },
  },
  defaultVariants: {size: 'default'},
});

type PageHeaderProps = React.ComponentProps<'header'> & VariantProps<typeof pageHeaderVariants> & {
  kind?: Kind;
  /** Shows a compact bar with the title and actions once the title scrolls out of view. */
  condense?: boolean;
  /** Where the compact bar sticks: a CSS length below a fixed top bar, as in "var(--topbar)". */
  condenseTop?: string;
  /**
   * The scroll area's inline padding around the header, as a CSS length ("var(--space-6)"). The bar
   * reaches out to the scroll area's edges by this much and pads back in by it, so its title starts on
   * the same left edge as the page title and the content. Defaults to 0: the bar spans the header's width.
   */
  condenseInset?: string;
};

/** The nearest ancestor that scrolls vertically, or null for the viewport. */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return null;
}

function PageHeader({className, size = 'default', kind, condense = false, condenseTop = '0px', condenseInset = '0px', children, ref, ...props}: PageHeaderProps) {
  const header = useRef<HTMLElement>(null);
  const headerRefs = useMemo(() => mergeRefs(header, ref), [ref]);
  const anchor = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState<ReactNode>(null);
  const [actions, setActions] = useState<ReactNode>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!condense) return;
    const target = header.current?.querySelector('[data-slot=page-header-title]');
    if (!target) return;
    const root = scrollParent(header.current);
    // The anchor's computed top resolves condenseTop (a var() or calc()) to px.
    const top = anchor.current ? parseFloat(getComputedStyle(anchor.current).top) || 0 : 0;
    const io = new IntersectionObserver(([entry]) => {
      // Stuck once the title is fully above the top edge of the scroll area.
      setStuck(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0) + top);
    }, {root, rootMargin: `-${top}px 0px 0px 0px`});
    io.observe(target);
    return () => io.disconnect();
  }, [condense]);

  const registry = useMemo(() => condense ? {setTitle, setActions} : null, [condense]);
  return <RegistryContext.Provider value={registry}>
    <header
      ref={headerRefs}
      data-slot="page-header"
      data-size={size}
      data-kind={kind}
      className={cn(pageHeaderVariants({size}), className)}
      {...props}
    >{children}</header>
    {condense && <div ref={anchor} data-slot="page-header-condensed-anchor" className="sticky z-(--z-above) h-0" style={{top: condenseTop, '--page-header-inset': condenseInset} as React.CSSProperties}>
      <div
        data-slot="page-header-condensed"
        data-stuck={stuck || undefined}
        aria-hidden={!stuck}
        inert={!stuck}
        className={cn(
          // The console's top bar with its frame line: on scroll the page's title and actions take its place.
          'absolute -inset-x-(--page-header-inset) top-0 flex h-(--topbar) items-center justify-between gap-4 bg-page px-(--page-header-inset) rule-row-frame',
          'transition-opacity duration-(--dur-base) ease-(--ease-step) motion-reduce:transition-none',
          stuck ? 'opacity-100' : 'pointer-events-none opacity-0',
          'forced-colors:border-b forced-colors:border-[CanvasText]',
        )}
      >
        <p className="min-w-0 truncate type-label">{title}</p>
        <ButtonSize size="sm"><div className="flex shrink-0 items-center gap-2">{actions}</div></ButtonSize>
      </div>
    </div>}
  </RegistryContext.Provider>;
}

/** Title block on the left, actions on the right. */
function PageHeaderRow({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="page-header-row" className={cn('flex flex-col gap-4 @3xl:flex-row @3xl:items-end @3xl:justify-between @3xl:gap-8', className)} {...props}/>;
}

function PageHeaderContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="page-header-content" className={cn('flex min-w-0 max-w-(--page-header-max) flex-col gap-2', className)} {...props}/>;
}

/** The title. When the kind matters, follow it with a kind label (<Badge kind="deploy"/>) on the same line. */
function PageHeaderTitle({className, children, ...props}: React.ComponentProps<'h1'>) {
  const registry = useContext(RegistryContext);
  useLayoutEffect(() => { registry?.setTitle(children); }, [registry, children]);
  return <h1 data-slot="page-header-title" className={cn('type-heading-lg text-pretty break-words @3xl:type-display group-data-[size=sm]/page-header:@3xl:type-heading-lg',
    // A kind badge after the name centres on the heading's line instead of sitting on its baseline.
    'has-data-[slot=badge]:flex has-data-[slot=badge]:flex-wrap has-data-[slot=badge]:items-center has-data-[slot=badge]:gap-x-3', className)} {...props}>
    {children}
  </h1>;
}

function PageHeaderDescription({className, ...props}: React.ComponentProps<'p'>) {
  return <p data-slot="page-header-description" className={cn('max-w-(--measure-hint) type-body text-text-2', className)} {...props}/>;
}

/** The page's actions: one primary, then secondary or ghost. They wrap in a narrow header. */
function PageHeaderActions({className, children, ...props}: React.ComponentProps<'div'>) {
  const registry = useContext(RegistryContext);
  useLayoutEffect(() => { registry?.setActions(children); }, [registry, children]);
  return <div data-slot="page-header-actions" className={cn('flex shrink-0 flex-wrap items-center gap-2', className)} {...props}>{children}</div>;
}

/** A row of stats under the title, as a description list. */
function PageHeaderStats({className, ...props}: React.ComponentProps<'dl'>) {
  // One frame, rules inside: the cells sit 1px apart on a row-rule ground, inside one frame line.
  return <dl data-slot="page-header-stats" className={cn('grid w-full grid-cols-2 gap-px bg-line-row frame [&>:last-child:nth-child(odd)]:col-span-2 @xl:flex @xl:w-fit', className)} {...props}/>;
}

/** One stat: a label, a numeral and an optional detail. */
function PageHeaderStat({className, label, value, detail, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {label: React.ReactNode; value: React.ReactNode; detail?: React.ReactNode}) {
  return <div data-slot="page-header-stat" className={cn('flex min-w-0 flex-col gap-1 bg-page px-4 py-3 @xl:min-w-36', className)} {...props}>
    <dt className="type-label-sm text-text-3">{label}</dt>
    <dd className="flex min-w-0 flex-wrap items-baseline gap-x-2">
      <span className="type-stat">{value}</span>
      {detail && <span className="type-label-sm text-text-2">{detail}</span>}
    </dd>
  </div>;
}

export {PageHeader, PageHeaderRow, PageHeaderContent, PageHeaderTitle, PageHeaderDescription, PageHeaderActions, PageHeaderStats, PageHeaderStat, pageHeaderVariants, type PageHeaderProps};
