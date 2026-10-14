import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import type {Kind} from '@/lib/quartz/kind';
import {Status, statusLabels, type StatusValue} from '@/components/quartz/ui/status';
import {cn} from '@/lib/quartz/utils';

// The list row: media, a title and a description, then meta, status and actions on
// one line. Rows live in an ItemGroup, the one frame, split by row rules. Rendered as a link or a button a row takes
// the hover wash. In a PanelBody it takes the panel's 12px inset by itself; in a Card it is a row split by row rules. Selected takes the kind's wash; `kind` on the row picks which hue. `muted` is deprecated and
// renders as default.
//
// The row gives up its parts in a fixed order as it narrows, measured by its own width (a container
// query on its content box, which is the row minus its padding), so it behaves the same in a 320px sidebar
// and a 1280px page: under 576px of content (608px of row at the default size) the meta goes first, under
// 384px (416px) an ID after the name in the title goes (a kind badge stays), and the name truncates last. The status word
// and the actions never drop. One waiting status in a short list keeps its InkSlot; long lists belong in a DataTable (see Status).

/** The one frame around a list of rows; each Item inside is a row split from the next by a row rule. */
function ItemGroup({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="item-group"
    className={cn('group/item-group relative flex w-full flex-col overflow-hidden bg-page frame', className)}
    {...props}
  />;
}

function ItemSeparator({className, ...props}: React.ComponentProps<'div'>) {
  return <div role="separator" aria-orientation="horizontal" data-slot="item-separator" className={cn('h-px shrink-0 bg-line-row', className)} {...props}/>;
}

const itemVariants = cva(
  [
    'group/item @container/item relative flex w-full min-w-0 flex-wrap items-center text-start text-text-1 transition-[background-color,box-shadow] duration-(--dur-fast) ease-(--ease-step)',
    // In a group: a row in the frame, split from the next by a row rule; the frame clips the corners.
    'in-data-[slot=item-group]:rounded-none in-data-[slot=item-group]:rule-row',
    // In a PanelBody: the same row, 12px in because the body already sits 4px inside the panel, so the text lands 16px from the panel's edge.
    'in-data-[slot=panel-body]:rounded-none in-data-[slot=panel-body]:rule-row in-data-[slot=panel-body]:px-3',
    // In a Card: the same row under the card's header, split by row rules; the card clips the corners.
    'in-data-[slot=card]:rounded-none in-data-[slot=card]:rule-row',
    // Hover never greys a selected row: the wash stays.
    '[a]:not-data-selected:not-aria-selected:hover:bg-hover [button]:not-data-selected:not-aria-selected:hover:bg-hover [a]:active:bg-pressed [button]:active:bg-pressed',
    // A row with an ItemLink is clickable everywhere but its actions, and takes the hover and press of a link.
    'not-data-selected:not-aria-selected:has-[[data-slot=item-link]:hover]:bg-hover has-[[data-slot=item-link]:active]:bg-pressed',
    // Selected: the wash. Alone it also draws a frame line above and below; in a group the row rules already do,
    // and a second box-shadow here would replace the rule (or double it against the row above).
    'aria-selected:bg-accent-wash data-selected:bg-accent-wash',
    'not-in-data-[slot=item-group]:aria-selected:shadow-[inset_0_1px_0_var(--line-frame),inset_0_-1px_0_var(--line-frame)] not-in-data-[slot=item-group]:data-selected:shadow-[inset_0_1px_0_var(--line-frame),inset_0_-1px_0_var(--line-frame)]',
    // Failing: a faint fail wash, as in a table (the status scope turns --accent-wash red); the status word says Failed.
    'data-[status=fail]:wash-row',
    'forced-colors:data-selected:outline forced-colors:data-selected:outline-2 forced-colors:data-selected:-outline-offset-2',
  ],
  {
    variants: {
      variant: {
        default: 'rounded-soft bg-transparent',
        /** Deprecated: renders as default. A grey row is a box in a box. */
        muted: 'rounded-soft bg-transparent',
        framed: 'frame',
        /** @deprecated Use framed. */
        outline: 'frame',
      },
      // The row tokens: --row (40px) for one line, --row-lg (56px) with a description, --row-sm (32px) and the 28px
      // control height for dense lists. Text is 16px from the frame's edge at every size.
      size: {
        default: 'min-h-(--row) gap-x-3 gap-y-1 px-4 py-2 has-data-[slot=item-description]:min-h-(--row-lg)',
        sm: 'min-h-(--row-sm) gap-x-3 gap-y-1 px-4 py-1.5',
        dense: 'min-h-(--control-sm) gap-x-2 px-4 py-1',
        /** @deprecated Use dense: 28px is the sm control height, and xs means 24px elsewhere. */
        xs: 'min-h-(--control-sm) gap-x-2 px-4 py-1',
      },
    },
    defaultVariants: {variant: 'default', size: 'default'},
  },
);

type ItemProps = useRender.ComponentProps<'div'> & VariantProps<typeof itemVariants> & {
  /** The selected item in a list. Takes the kind's wash. */
  selected?: boolean;
  /** The kind of thing the row is. Sets data-kind, so selection takes that wash. */
  kind?: Kind;
};

function Item({className, variant = 'default', size: sizeProp = 'default', selected, kind, render, ...props}: ItemProps) {
  const size = sizeProp === 'xs' ? 'dense' : sizeProp;
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {className: cn(itemVariants({variant, size}), className)},
      {
        'data-slot': 'item',
        'data-size': size,
        'data-kind': kind,
        'data-selected': selected ? '' : undefined,
        'aria-current': selected && render ? 'true' : undefined,
      } as React.ComponentProps<'div'>,
      props,
    ),
    render,
    state: {slot: 'item', variant, size},
  });
}

const itemMediaVariants = cva(
  'flex shrink-0 items-center justify-center gap-2 group-has-data-[slot=item-description]/item:self-start [&_svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'rounded-soft bg-transparent',
        icon: 'size-8 text-text-2 group-data-[size=dense]/item:size-6',
        image: 'size-10 overflow-hidden rounded-soft group-data-[size=sm]/item:size-8 group-data-[size=dense]/item:size-6 [&_img]:size-full [&_img]:object-cover',
      },
    },
    defaultVariants: {variant: 'default'},
  },
);

/** The lead: an avatar, an icon or an image. A kind goes in the title row as a label (<Badge kind="run"/>), never here. */
function ItemMedia({className, variant = 'default', ...props}: React.ComponentProps<'div'> & VariantProps<typeof itemMediaVariants>) {
  return <div data-slot="item-media" data-variant={variant} className={cn(itemMediaVariants({variant, className}))} {...props}/>;
}

function ItemContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="item-content"
    className={cn('flex min-w-0 flex-1 flex-col gap-0.5 [&+[data-slot=item-content]]:flex-none', className)}
    {...props}
  />;
}

/**
 * The name, then an optional ID. Under 384px of content width the ID goes; the name truncates last. It clips
 * its own overflow, so at 200% text an ID that cannot shrink further is cut inside the title instead of
 * running over the status. The row link's hit area is positioned on the row, so the clip never cuts it.
 */
function ItemTitle({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="item-title" className={cn('flex w-fit max-w-full min-w-0 items-baseline gap-2 overflow-hidden type-label [&>*:first-child]:min-w-0 [&>*:first-child]:truncate @max-sm/item:[&>*:not(:first-child):not([data-slot=badge])]:hidden', className)} {...props}/>;
}

function ItemDescription({className, ...props}: React.ComponentProps<'p'>) {
  return <p
    data-slot="item-description"
    className={cn('line-clamp-2 type-body-sm text-text-2 group-data-[size=dense]/item:line-clamp-1 [&>a]:underline [&>a]:underline-offset-4', className)}
    {...props}
  />;
}

/** A time, an owner, a count. The first thing the row drops: hidden under 576px of content width. */
function ItemMeta({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="item-meta" className={cn('shrink-0 type-body-sm text-text-3 @max-xl/item:hidden', className)} {...props}/>;
}

/** The row's status, as a word. */
function ItemStatus({status, className, children, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {status: StatusValue; children?: React.ReactNode}) {
  return <div data-slot="item-status" className={cn('inline-flex shrink-0 items-center type-label-sm text-text-2', className)} {...props}>
    <Status status={status} className="type-label-sm">{children ?? statusLabels[status]}</Status>
  </div>;
}

/**
 * The row's link, inside ItemTitle. Its hit area stretches over the whole row, so the row opens on a click
 * anywhere, while ItemActions stay their own buttons on top of it: no button inside a link, one tab stop
 * for the row, and the focus ring drawn around the whole row.
 */
function ItemLink({className, ...props}: React.ComponentProps<'a'>) {
  return <a
    data-slot="item-link"
    className={cn(
      'min-w-0 truncate after:absolute after:inset-0 after:rounded-soft after:content-[""]',
      'focus-visible:outline-none focus-visible:after:focus-ring-inset',
      className,
    )}
    {...props}
  />;
}

/** Buttons at the end of the row. Ghost and icon-sized; they never drop, and sit above an ItemLink. */
function ItemActions({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="item-actions" className={cn('relative z-(--z-raised) flex shrink-0 items-center gap-1', className)} {...props}/>;
}

function ItemHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="item-header" className={cn('flex basis-full items-center justify-between gap-2', className)} {...props}/>;
}

function ItemFooter({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="item-footer" className={cn('flex basis-full items-center justify-between gap-2', className)} {...props}/>;
}

export {Item, ItemMedia, ItemContent, ItemActions, ItemLink, ItemGroup, ItemSeparator, ItemTitle, ItemDescription, ItemMeta, ItemStatus, ItemHeader, ItemFooter, itemVariants, type ItemProps};
