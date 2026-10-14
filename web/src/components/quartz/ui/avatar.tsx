'use client';

import {Avatar as AvatarPrimitive} from '@base-ui/react/avatar';
import {Children, createContext, isValidElement, useContext, useEffect, useRef, useState, type ReactElement} from 'react';
import {cva, type VariantProps} from 'class-variance-authority';
import {Icon, Bot, Globe} from '@/components/quartz/icon';
import {StatusArc, statusLabels, type StatusValue} from '@/components/quartz/ui/status';
import {TextHint} from '@/components/quartz/ui/truncate';
import {cn, mergeClass} from '@/lib/quartz/utils';

// Who or what did something: a person, an agent or a source, alone or grouped. Built on Base
// UI's Avatar, so the fallback shows while an image loads and stays if it fails.
// - person: round, the only round thing in Quartz besides the radio. Initials on paper in a round control edge.
// - agent: a soft-cornered (6px) square on the agent tint with the bot glyph in the label step, so a person and an
//   agent never read alike. Never initials: a monogram square would stand in for a thing.
// - source: a soft-cornered square for a cited page or a connected tool (was Favicon). The fallback is the
//   globe, never a letter (a monogram square would stand in for a thing). It never asks a third-party favicon service.
//
// Pass `name` and the avatar works out its own initials and accessible name. AvatarGroup overlaps them
// and folds the rest into +N; the +N names who it hides, on hover, on focus and to screen readers, so a
// folded group never hides people.

const avatarVariants = cva('group/avatar relative inline-flex shrink-0 select-none', {
  variants: {
    size: {
      '2xs': 'size-4',
      xs: 'size-5',
      sm: 'size-6',
      default: 'size-8',
      lg: 'size-10',
    },
    type: {
      // Round means a person. Everything else takes the soft 6px corner.
      person: 'rounded-full',
      agent: 'rounded-soft',
      source: 'overflow-hidden rounded-soft',
    },
  },
  defaultVariants: {size: 'default', type: 'person'},
});

type AvatarSize = NonNullable<VariantProps<typeof avatarVariants>['size']>;
type AvatarType = NonNullable<VariantProps<typeof avatarVariants>['type']>;

/**
 * Up to two letters from a name: first and last word, or the first two letters of one word. Emails use
 * the part before @; URLs drop the scheme and www. Letters only, in any script.
 */
function initialsOf(name: string, type: AvatarType = 'person', size: AvatarSize = 'default') {
  const clean = name.replace(/^(https?:\/\/)?(www\.)?/i, '').split('@')[0];
  const words = clean.split(/[\s._\-/]+/).map(w => w.match(/[\p{L}\p{N}]/gu)?.join('') ?? '').filter(Boolean);
  if (!words.length) return '';
  // Sources, and anything 24px or smaller, take one letter: two do not fit.
  if (type === 'source' || size === '2xs' || size === 'xs' || size === 'sm') return [...words[0]][0].toUpperCase();
  if (words.length === 1) return [...words[0]].slice(0, 2).join('').toUpperCase();
  return ([...words[0]][0] + [...words[words.length - 1]][0]).toUpperCase();
}

const globeSize = {'2xs': 12, xs: 12, sm: 16, default: 20, lg: 20} as const;

/** The root's type and size, so a bare <AvatarFallback/> picks the right glyph at the right size. */
const AvatarContext = createContext<{type: AvatarType; size: AvatarSize; setStatus?: (status: string | undefined) => void}>({type: 'person', size: 'default'});

type AvatarProps = AvatarPrimitive.Root.Props & VariantProps<typeof avatarVariants> & {
  /** The person's, agent's or source's name. Gives the initials and the accessible name. */
  name?: string;
  /** An image. Served from your own origin or cache for sources; it never calls a favicon service. */
  src?: string;
  /** Hide the name from assistive tech, when the name is written next to the avatar. */
  decorative?: boolean;
};

function Avatar({className, size = 'default', type = 'person', name, src, decorative, children, ...props}: AvatarProps) {
  const px: AvatarSize = size ?? 'default';
  const kind: AvatarType = type ?? 'person';
  // A badge inside a role=img is presentational, so the badge hands its status to the avatar's own name.
  const [status, setStatus] = useState<string>();
  const labelled = !!name && !decorative;
  return <AvatarContext.Provider value={{type: kind, size: px, setStatus}}><AvatarPrimitive.Root
    data-slot="avatar"
    data-size={px}
    data-type={kind}
    data-kind={kind === 'agent' ? 'agent' : undefined}
    role={labelled || props['aria-label'] ? 'img' : undefined}
    aria-label={labelled ? (status ? `${name}, ${status}` : name) : undefined}
    aria-hidden={decorative || undefined}
    className={mergeClass(avatarVariants({size: px, type: kind}), className)}
    {...props}
  >
    {children ?? <>
      {src && <AvatarImage src={src} alt="" referrerPolicy={kind === 'source' ? 'no-referrer' : undefined}/>}
      <AvatarFallback>{name && kind === 'person' && initialsOf(name, kind, px) ? <Initials>{initialsOf(name, kind, px)}</Initials> : undefined}</AvatarFallback>
    </>}
  </AvatarPrimitive.Root></AvatarContext.Provider>;
}

function AvatarImage({className, ...props}: AvatarPrimitive.Image.Props) {
  return <AvatarPrimitive.Image
    data-slot="avatar-image"
    decoding="async"
    draggable={false}
    className={mergeClass('aspect-square size-full rounded-[inherit] object-cover group-data-[type=source]/avatar:object-contain', className)}
    {...props}
  />;
}

/**
 * Initials for a person or an agent, the first letter for a source. With no children: a globe for
 * sources, nothing for people and agents.
 */
function AvatarFallback({className, children, ...props}: AvatarPrimitive.Fallback.Props) {
  return <AvatarPrimitive.Fallback
    data-slot="avatar-fallback"
    className={mergeClass([
      'flex size-full items-center justify-center overflow-hidden rounded-[inherit] bg-page type-label-sm text-text-1',
      // A person's initials and a source's letter sit on paper inside the control edge; an image has no edge.
      'group-data-[type=person]/avatar:control-edge group-data-[type=source]/avatar:control-edge group-data-[type=source]/avatar:text-text-2',
      // In a group the next avatar covers this one's end; the letters centre in what stays visible.
      'pe-(--avatar-covered)',
      'group-data-[type=agent]/avatar:bg-accent-tint group-data-[type=agent]/avatar:text-accent-label',
      'group-data-[size=lg]/avatar:type-label',
      'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1',
    ], className)}
    {...props}
  >
    {children ?? <FallbackGlyph/>}
  </AvatarPrimitive.Fallback>;
}

/**
 * Initials that never spill or get covered. They centre in the visible part of the avatar, and when two
 * letters do not fit that part (a wide pair like WM, or text at 200%) they drop to the first letter; when
 * one letter still does not fit, it scales down to the box. The avatar's name carries the full name.
 */
function Initials({children}: {children: string}) {
  const full = useRef<HTMLSpanElement>(null);
  const first = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{one: boolean; scale: number}>({one: false, scale: 1});
  const letters = [...children];
  useEffect(() => {
    const two = full.current;
    const one = first.current;
    const box = two?.parentElement?.parentElement;
    if (!two || !one || !box) return;
    const measure = () => {
      const style = getComputedStyle(box);
      const width = box.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd);
      const round = style.borderTopLeftRadius.endsWith('%') || parseFloat(style.borderTopLeftRadius) >= box.clientWidth / 2;
      const room = (h: number) => {
        // A circle is narrower away from its middle: the chord at the letters' top and bottom.
        if (!round) return width;
        const r = box.clientWidth / 2;
        const chord = 2 * Math.sqrt(Math.max(0, r * r - (h / 2) * (h / 2)));
        return Math.min(width, chord - (box.clientWidth - width));
      };
      const fitsTwo = letters.length < 2 || two.offsetWidth <= room(two.offsetHeight * 0.6);
      const w = (fitsTwo ? two : one).offsetWidth;
      const h = (fitsTwo ? two : one).offsetHeight * 0.6;
      const scale = Math.min(1, room(h) / Math.max(w, 1), box.clientHeight / Math.max(h / 0.6, 1));
      setFit({one: !fitsTwo, scale});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    observer.observe(two);
    return () => observer.disconnect();
  }, [children]);
  const measurer = 'invisible absolute whitespace-nowrap';
  return <span data-slot="avatar-initials" className="relative inline-flex">
    <span ref={full} aria-hidden className={measurer}>{children}</span>
    <span ref={first} aria-hidden className={measurer}>{letters[0]}</span>
    <span
      data-fit={fit.one ? 'one' : 'full'}
      className="inline-block whitespace-nowrap"
      style={fit.scale < 1 ? {transform: `scale(${fit.scale})`} : undefined}
    >{fit.one ? letters[0] : children}</span>
  </span>;
}

function FallbackGlyph() {
  const {type, size} = useContext(AvatarContext);
  if (type === 'source') return <Icon icon={Globe} size={globeSize[size]}/>;
  if (type === 'agent') return <Icon icon={Bot} size={globeSize[size]}/>;
  return null;
}

type AvatarBadgeProps = React.ComponentProps<'span'> & {status?: StatusValue; label?: string};

/**
 * The avatar's status. Its word joins the avatar's name ("Maya Chen, Online"). Only running draws anything,
 * the small turning arc on the corner, cut out of whatever it sits on by a 2px ring.
 */
function AvatarBadge({status = 'ok', className, label, ...props}: AvatarBadgeProps) {
  const {setStatus} = useContext(AvatarContext);
  const name = label ?? statusLabels[status];
  useEffect(() => {
    setStatus?.(name);
    return () => setStatus?.(undefined);
  }, [setStatus, name]);
  return <span
    aria-hidden
    data-slot="avatar-badge"
    className={cn(
      'absolute -right-0.5 -bottom-0.5 z-(--z-raised) inline-flex p-0.5 [--avatar-cutout:var(--surface-page)] bg-(--avatar-cutout)',
      className,
    )}
    {...props}
  >
    {status === 'running' ? <StatusArc/> : null}
  </span>;
}

type GroupSize = 'xs' | 'sm' | 'default' | 'lg';
// How far each avatar slides under the one before it. Logical margins, so the overlap runs the other way
// under dir="rtl". Each covered avatar learns how much of its end is hidden (the overlap plus the cutout
// ring) and centres its initials in the rest, so a covered avatar never loses a letter.
const overlap: Record<GroupSize, string> = {
  xs: '[--avatar-overlap:var(--space-1)]',
  sm: '[--avatar-overlap:var(--space-1)]',
  default: '[--avatar-overlap:calc(var(--space-1)*1.5)]',
  lg: '[--avatar-overlap:var(--space-2)]',
};
const countSize: Record<GroupSize, string> = {xs: 'size-5 type-label-sm', sm: 'size-6 type-label-sm', default: 'size-8 type-label-sm', lg: 'size-10 type-label'};

type AvatarGroupProps = React.ComponentProps<'div'> & {
  /** How many avatars to show, counting the +N. Past it the rest fold into the count. */
  max?: number;
  /** The accessible name for the group: "People on this run". */
  label?: string;
  /** The size of the avatars inside, so the count matches them. */
  size?: GroupSize;
};

/** Avatars that overlap, each cut out of the surface by a 2px ring, with every initial left in view. */
function AvatarGroup({className, children, max = 4, label, size = 'default', ...props}: AvatarGroupProps) {
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<{name?: string}>[];
  const shown = items.length > max ? items.slice(0, Math.max(1, max - 1)) : items;
  const hidden = items.slice(shown.length);
  return <div
    data-slot="avatar-group"
    data-size={size}
    role="list"
    aria-label={label}
    className={cn(
      'group/avatar-group flex items-center [--avatar-cutout:var(--surface-page)]',
      '[&>*+*]:-ms-(--avatar-overlap) [&>*:not(:last-child)]:[--avatar-covered:calc(var(--avatar-overlap)+var(--ring-cutout))]',
      overlap[size],
      className,
    )}
    {...props}
  >
    {shown.map((item, i) => <div key={item.key ?? i} role="listitem" className="relative flex rounded-full shadow-[0_0_0_var(--ring-cutout)_var(--avatar-cutout)] has-data-[type=agent]:rounded-soft has-data-[type=source]:rounded-soft">{item}</div>)}
    {hidden.length > 0 && <AvatarGroupCount size={size} names={hidden.map(h => h.props.name).filter((n): n is string => !!n)}>{hidden.length}</AvatarGroupCount>}
  </div>;
}

/** The +N at the end of a group. It names who it hides on hover and focus, and to screen readers. */
function AvatarGroupCount({className, children, size = 'default', names = [], ...props}: React.ComponentProps<'div'> & {size?: GroupSize; names?: string[]}) {
  const list = names.length ? names.join(', ') : undefined;
  const count = <div
    data-slot="avatar-group-count"
    role="listitem"
    tabIndex={list ? 0 : undefined}
    className={cn(
      'relative flex shrink-0 items-center justify-center rounded-full bg-page text-text-1 data shadow-[inset_0_0_0_1px_var(--line-control),0_0_0_var(--ring-cutout)_var(--avatar-cutout)]',
      'forced-colors:outline forced-colors:outline-1',
      countSize[size],
      className,
    )}
    {...props}
  >
    <span aria-hidden dir="ltr">+{children}</span>
    <span className="sr-only">and {children} more{list ? `: ${list}` : ''}</span>
  </div>;
  return list ? <TextHint content={list}>{count}</TextHint> : count;
}

export {Avatar, AvatarImage, AvatarFallback, AvatarBadge, Initials as AvatarInitials, AvatarGroup, AvatarGroupCount, avatarVariants, initialsOf, type AvatarProps, type AvatarSize, type AvatarType};
