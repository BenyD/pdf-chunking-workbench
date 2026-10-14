'use client';

import {Button as ButtonPrimitive} from '@base-ui/react/button';
import {Toggle as TogglePrimitive} from '@base-ui/react/toggle';
import {cva, type VariantProps} from 'class-variance-authority';
import * as React from 'react';
import type {KeyboardEvent, MouseEvent} from 'react';
import {Icon, ChevronDown, Close} from '@/components/quartz/icon';
import type {Kind} from '@/lib/quartz/kind';
import {cn, mergeClass} from '@/lib/quartz/utils';

// Quartz's chip: the small token a person can act on. Three jobs share one look and one size:
// - Chip: a filter that is on or off (Base UI Toggle). Pressed is the selected wash with a darker edge, kind or no kind.
// - Chip with onRemove: a value someone chose (was Tag), with a real remove button. Removing it hands
//   focus to the next value's remove button, else the previous one, so a keyboard user can clear a row
//   of values with Enter or Backspace without focus falling to the page. The last value has no neighbour:
//   the caller names where focus goes then, with focusAfterEmpty (an add or filter control).
// - ChipButton: an action (Base UI Button): a link to a filtered view, or a menu trigger with a caret.
// All are paper with a 1px control edge and the field's short lift, 28px tall (24px at xs; sm and default are the same 28, default being sm), on the soft corner, and carry
// the kind as data-kind, never as an icon or a colour: name the kind in the label. Hover darkens the edge (--line-control-hover)
// and nothing else; on is the selected wash with that darker edge.
// Every chip draws its own edge. A ChipGroup is a row 4px apart: "wrap" wraps onto lines, "strip" stays on one line (a table
// toolbar, a filter row). Joined cells that share one line belong to FilterBar, which sets the shared edge through
// ChipGroupContext; there the hovered or on cell also draws its end edge, so both of its sides read.
// Pressed styles key off aria-pressed, not data-pressed, so a ChipButton used as a menu trigger (which
// Base UI marks data-pressed while open) never takes the selected wash by accident. data-active gives a ChipButton the
// same "on" look, for a filter chip whose menu has a value set (dropdown-select).

const chipVariants = cva(
  [
    'group/chip relative inline-flex max-w-full min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap select-none',
    'text-text-1 transition-[background-color,color,scale,outline-color] duration-(--dur-fast) ease-(--ease-step)',
    'active:not-data-disabled:not-data-[slot=chip-value]:scale-(--scale-press) active:duration-(--dur-press)',
    'hover:not-data-disabled:[--frame-color:var(--line-control-hover)]',
    'aria-pressed:not-data-disabled:bg-selected aria-pressed:[--frame-color:var(--line-control-hover)]',
    'data-active:not-data-disabled:bg-selected data-active:[--frame-color:var(--line-control-hover)]',
    // A pressed or active chip paints its icon in its own text color.
    'aria-pressed:[&_[data-slot=chip-icon]]:text-current data-active:[&_[data-slot=chip-icon]]:text-current',
    // A filter that is on but cannot change keeps its darker edge and drops the fill, so an applied filter stays visible.
    'data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
    'data-invalid:bg-accent-wash data-invalid:[--frame-color:var(--accent-line)]',
    'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1 forced-colors:aria-pressed:outline-2 forced-colors:aria-pressed:-outline-offset-2',
    // Forced colors drops the wash and the edge colour, so active and invalid need their own outlines.
    'forced-colors:data-active:outline-2 forced-colors:data-active:-outline-offset-2 forced-colors:data-invalid:outline-2 forced-colors:data-invalid:outline-dashed forced-colors:data-invalid:-outline-offset-2',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        secondary: 'bg-page',
        outline: 'bg-page',
        ghost: 'bg-transparent before:hidden hover:not-data-disabled:not-aria-pressed:not-data-active:bg-hover',
      },
      size: {
        xs: 'h-(--control-xs) px-2 type-label-sm has-data-[slot=chip-icon]:ps-1.5',
        sm: 'h-(--control-sm) px-2.5 type-label has-data-[slot=chip-icon]:ps-2',
        default: 'h-(--control-sm) px-2.5 type-label has-data-[slot=chip-icon]:ps-2',
      },
      edge: {
        own: 'frame [--frame-radius:var(--radius-soft)] [--frame-color:var(--line-control)]',
        // A hovered, on or open cell rises over its neighbour and draws its end edge over the neighbour's start edge,
        // so the darker line closes on both sides.
        shared: [
          'frame-shared focus-visible:focus-ring-inset',
          '[&:is(:hover:not([data-disabled]),[aria-pressed=true],[data-active],[data-popup-open]):not(:last-child)]:z-(--z-raised)',
          '[&:is(:hover:not([data-disabled]),[aria-pressed=true],[data-active],[data-popup-open]):not(:last-child)]:before:-end-px',
          '[&:is(:hover:not([data-disabled]),[aria-pressed=true],[data-active],[data-popup-open]):not(:last-child)]:before:border-e-1',
        ],
      },
    },
    // Alone, a paper chip sits on the same short lift as a field and a secondary button.
    compoundVariants: [
      {variant: ['secondary', 'outline'], edge: 'own', className: 'shadow-(--elev-control)'},
    ],
    defaultVariants: {variant: 'secondary', size: 'default', edge: 'own'},
  },
);

type ChipGroupVariant = 'wrap' | 'strip';
const ChipGroupContext = React.createContext<ChipGroupVariant>('wrap');
/** Chips in a strip share their neighbours' lines; elsewhere each draws its own edge. */
const useEdge = () => (React.useContext(ChipGroupContext) === 'strip' ? 'shared' : 'own');

/**
 * A count after the label: the number in tabular figures and text-3, no rule between them.
 */
function ChipCount({children, className}: {children: React.ReactNode; className?: string}) {
  return <span data-slot="chip-count" className={cn('ms-0.5 type-label-sm data text-text-3', className)}>{children}</span>;
}

/** A string label truncates with an ellipsis, so a chip squeezed by its row never cuts a glyph. */
function ChipLabel({children}: {children: React.ReactNode}) {
  return typeof children === 'string' ? <span className="min-w-0 truncate">{children}</span> : children;
}

type ChipOwnProps = VariantProps<typeof chipVariants> & {
  /** A number after the label: matching rows, active filters. */
  count?: number;
  /** The kind this chip names. Sets data-kind and nothing else: pressed is ink for every chip, so name the kind in the label. */
  kind?: Kind;
};

type ChipValueProps = {
  /** Makes the chip a removable value (was Tag). Called by the remove button, Backspace or Delete. */
  onRemove: () => void;
  /** Accessible name for the remove button. Defaults to "Remove" plus the chip's text. */
  removeLabel?: string;
  /** A value the field will not accept. Shows the fail wash; say why in the field's error text. */
  invalid?: boolean;
  disabled?: boolean;
  /**
   * Where focus goes when this was the last value in the row: an add or filter control the caller names.
   * Without it focus has nowhere to land and falls to the page.
   */
  focusAfterEmpty?: React.RefObject<HTMLElement | null>;
};

type ChipProps =
  | (TogglePrimitive.Props & ChipOwnProps & {onRemove?: undefined; removeLabel?: never; invalid?: never})
  | (Omit<React.ComponentProps<'span'>, 'onChange'> & ChipOwnProps & ChipValueProps);

function Chip(props: ChipProps) {
  const edge = useEdge();
  if (props.onRemove) return <ChipValue {...(props as Omit<React.ComponentProps<'span'>, 'onChange'> & ChipOwnProps & ChipValueProps)}/>;
  const {className, variant = 'secondary', size = 'default', count, kind, children, ...rest} = props as TogglePrimitive.Props & ChipOwnProps;
  return <TogglePrimitive
    data-slot="chip"
    data-kind={kind}
    className={mergeClass(chipVariants({variant, size, edge}), className)}
    {...rest}
  >
    <ChipLabel>{children}</ChipLabel>
    {count !== undefined && <ChipCount>{count}</ChipCount>}
  </TogglePrimitive>;
}

/** Where focus goes after a value is removed: the next value's remove button, else the previous one. */
function focusAfterRemove(button: HTMLElement, fallback?: React.RefObject<HTMLElement | null>) {
  const scope = button.closest('[data-slot=chip-group]') ?? button.closest('[data-slot=chip-value]')?.parentElement;
  if (!scope) return () => {};
  const all = [...scope.querySelectorAll<HTMLElement>('[data-slot=chip-remove]:not(:disabled)')];
  const i = all.indexOf(button);
  const target = all[i + 1] ?? all[i - 1];
  return () => {
    if (target?.isConnected) target.focus();
    else if (!target) fallback?.current?.focus();
  };
}

function ChipValue({className, variant = 'secondary', size = 'default', count, kind, children, onRemove, removeLabel, invalid, disabled, focusAfterEmpty, ...props}: Omit<React.ComponentProps<'span'>, 'onChange'> & ChipOwnProps & ChipValueProps) {
  const text = typeof children === 'string' ? children : undefined;
  const remove = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    const refocus = focusAfterRemove(event.currentTarget, focusAfterEmpty);
    onRemove();
    requestAnimationFrame(refocus);
  };
  return <span
    data-slot="chip-value"
    data-kind={kind}
    data-status={invalid ? 'fail' : undefined}
    data-invalid={invalid || undefined}
    data-disabled={disabled || undefined}
    className={cn(chipVariants({variant, size, edge: useEdge()}), size === 'xs' ? 'pe-0.5' : 'pe-1', className)}
    {...props}
  >
    <span className="min-w-0 truncate">{children}</span>
    {count !== undefined && <ChipCount>{count}</ChipCount>}
    {invalid && <span className="sr-only">(invalid)</span>}
    <button
      type="button"
      data-slot="chip-remove"
      onClick={remove}
      onKeyDown={event => { if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); remove(event); } }}
      disabled={disabled}
      aria-label={removeLabel ?? (text ? `Remove ${text}` : 'Remove')}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-inner text-text-2 transition-colors duration-(--dur-fast) ease-(--ease-step)',
        'hover:not-disabled:bg-hover hover:not-disabled:text-text-1 focus-visible:outline-offset-0 disabled:text-text-disabled',
        // The hit area reaches the chip's full height, so the 20px glyph box is still a 24px target.
        'relative after:absolute after:-inset-y-1 after:-inset-x-0.5 after:content-[""]',
        size === 'xs' ? 'size-5' : 'size-6',
      )}
    >
      <Icon icon={Close} size={12}/>
    </button>
  </span>;
}

/**
 * A row of chips, 4px apart, each on its own edge. Gives removal its focus scope. `wrap` (default) wraps onto lines,
 * for removable values. `strip` stays on one line and never wraps, for toggle filters in a table toolbar: a filter bar
 * moves it to its own row when narrow.
 */
function ChipGroup({className, variant = 'wrap', ...props}: React.ComponentProps<'div'> & {variant?: ChipGroupVariant}) {
  return <ChipGroupContext.Provider value="wrap">
    <div data-slot="chip-group" data-variant={variant} className={cn('flex items-center gap-1', variant === 'strip' ? 'max-w-full' : 'flex-wrap', className)} {...props}/>
  </ChipGroupContext.Provider>;
}

type ChipButtonProps = ButtonPrimitive.Props & ChipOwnProps & {
  /** A trailing caret, for a chip that opens a menu. */
  chevron?: boolean;
};

function ChipButton({className, variant = 'secondary', size = 'default', count, kind, chevron, children, ...props}: ChipButtonProps) {
  return <ButtonPrimitive
    data-slot="chip-button"
    data-kind={kind}
    className={mergeClass([chipVariants({variant, size, edge: useEdge()}), 'data-popup-open:[--frame-color:var(--line-control-hover)]'], className)}
    {...props}
  >
    <ChipLabel>{children}</ChipLabel>
    {count !== undefined && <ChipCount>{count}</ChipCount>}
    {chevron && <Icon icon={ChevronDown} size={12} className="-me-0.5 text-text-2 transition-transform duration-(--dur-fast) group-data-popup-open/chip:rotate-180"/>}
  </ButtonPrimitive>;
}

export {Chip, ChipButton, ChipCount, ChipGroup, ChipGroupContext, chipVariants, type ChipProps, type ChipButtonProps, type ChipGroupVariant, type ChipValueProps};
