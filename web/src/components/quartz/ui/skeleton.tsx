'use client';

import {useEffect, useRef, useState, type ReactNode} from 'react';
import {cn} from '@/lib/quartz/utils';
import {cssNumber} from '@/lib/quartz/css-var';

// Holds the shape of content while it loads, so nothing moves when the content arrives.
// - Skeleton is a box. Give it the size classes of the real thing (size-8, h-(--control) w-24).
// - SkeletonText is lines of text. Pass the type role of the real text: each line is 1lh of that role, so
//   a three-line body paragraph and its skeleton are the same height to the pixel.
// - SkeletonSwap decides when to show it.
//
// The considered detail is that a skeleton never flashes. On a first load SkeletonSwap holds the
// skeleton's space but keeps it invisible for the first 150ms, so a fast response swaps straight to
// content; once the skeleton has shown, it stays at least 400ms, so a response at 170ms does not blink it
// on and off. On a reload the content already on screen stays put (aria-busy at once, then --stale-opacity after the same 150ms, so a quick refetch never dims) and the
// skeleton never shows: a skeleton stands in for missing content, not for content being refreshed. The fill is a still block: no sweep, no pulse.

function Skeleton({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="skeleton"
    aria-hidden
    className={cn(
      'relative shrink-0 overflow-hidden rounded-soft bg-(--surface-skeleton)',
      'forced-colors:bg-[GrayText]',
      className,
    )}
    {...props}
  />;
}

type TextRole = 'display' | 'heading-lg' | 'heading' | 'heading-sm' | 'body-lg' | 'body' | 'body-sm' | 'label' | 'label-sm' | 'code' | 'code-sm';

const roles: Record<TextRole, string> = {
  display: 'type-display', 'heading-lg': 'type-heading-lg', heading: 'type-heading', 'heading-sm': 'type-heading-sm',
  'body-lg': 'type-body-lg', body: 'type-body', 'body-sm': 'type-body-sm', label: 'type-label', 'label-sm': 'type-label-sm',
  code: 'type-code', 'code-sm': 'type-code-sm',
};

type SkeletonTextProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  /** The type role of the text it stands in for. Sets the line height, so heights match exactly. */
  type?: TextRole;
  /** Number of lines. */
  lines?: number;
  /** Width of the last line, as a fraction of the full width. */
  last?: number;
};

function SkeletonText({className, type = 'body', lines = 1, last = 0.6, ...props}: SkeletonTextProps) {
  return <div data-slot="skeleton-text" data-type={type} aria-hidden className={cn('flex w-full flex-col', roles[type], className)} {...props}>
    {Array.from({length: Math.max(1, lines)}, (_, i) => <div key={i} className="flex h-lh items-center">
      <Skeleton
        className="h-(--skeleton-text) rounded-inner"
        style={{width: lines > 1 && i === lines - 1 ? `${last * 100}%` : '100%'}}
      />
    </div>)}
  </div>;
}

type SkeletonSwapProps = {
  /** True while the content is loading. */
  loading: boolean;
  /** The skeleton, shaped like the content. */
  fallback: ReactNode;
  children: ReactNode;
  /** ms the skeleton stays invisible before it shows. A response inside it swaps straight to content. */
  delay?: number;
  /** ms the skeleton stays once shown. */
  minDuration?: number;
  /** Names what is loading for screen readers, as in "Loading runs". */
  label?: string;
  className?: string;
};

/**
 * Shows fallback on a first load, without a flash: invisible for `delay` (its space held), then shown for
 * at least `minDuration`. On a reload, when content has already been shown, the content stays in place
 * and the region is only marked busy (data-stale, aria-busy): a skeleton never replaces content the person
 * is reading, and nothing goes blank.
 */
function SkeletonSwap({loading, fallback, children, delay: delayProp, minDuration: holdProp, label = 'Loading', className}: SkeletonSwapProps) {
  const [phase, setPhase] = useState<'hidden' | 'shown' | 'done'>(loading ? 'hidden' : 'done');
  // True once the content has been on screen; from then on a reload keeps it.
  const [hasContent, setHasContent] = useState(!loading);
  const shownAt = useRef(0);
  const ref = useRef<HTMLDivElement>(null);
  // The defaults are --dur-skeleton-delay and --dur-skeleton-hold, read off the element.
  const delay = delayProp ?? cssNumber(ref.current, '--dur-skeleton-delay', 150);
  const minDuration = holdProp ?? cssNumber(ref.current, '--dur-skeleton-hold', 400);

  useEffect(() => {
    if (loading) {
      if (hasContent) return;
      setPhase('hidden');
      const t = setTimeout(() => { shownAt.current = Date.now(); setPhase('shown'); }, delay);
      return () => clearTimeout(t);
    }
    setPhase(p => {
      if (p !== 'shown') return 'done';
      return p;
    });
  }, [loading, delay, hasContent]);

  // Once shown, hold until minDuration has passed, even if loading already ended.
  useEffect(() => {
    if (loading || phase !== 'shown') return;
    const left = minDuration - (Date.now() - shownAt.current);
    const t = setTimeout(() => setPhase('done'), Math.max(0, left));
    return () => clearTimeout(t);
  }, [loading, phase, minDuration]);

  useEffect(() => { if (phase === 'done' && !loading) setHasContent(true); }, [phase, loading]);

  const reloading = loading && hasContent;
  // The dim waits the same delay as the skeleton, so an 80ms refetch never flickers 100% to 60% and back.
  const [dim, setDim] = useState(false);
  useEffect(() => {
    if (!reloading) { setDim(false); return; }
    const t = setTimeout(() => setDim(true), delay);
    return () => clearTimeout(t);
  }, [reloading, delay]);
  const holding = !reloading && phase !== 'done';
  return <div ref={ref} data-slot="skeleton-swap" data-phase={reloading ? 'stale' : phase} data-stale={(reloading && dim) || undefined} aria-busy={holding || reloading || undefined} className={cn('data-stale:opacity-(--stale-opacity)', className)}>
    {holding
      ? <><div className={cn(phase === 'hidden' && 'invisible')}>{fallback}</div><span className="sr-only" role="status">{phase === 'shown' ? label : ''}</span></>
      : children}
  </div>;
}

export {Skeleton, SkeletonText, SkeletonSwap, type SkeletonTextProps, type SkeletonSwapProps, type TextRole};
