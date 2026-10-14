'use client';

import * as React from 'react';
import {Tooltip as TooltipPrimitive} from '@base-ui/react/tooltip';
import {cn, mergeClass} from '@/lib/quartz/utils';
import {useQuartzPortal} from '@/lib/quartz/portal';
import {isPart} from '@/lib/quartz/children';
import {Kbd, KbdGroup} from '@/components/quartz/ui/kbd';

// Quartz's tooltip, on Base UI's Tooltip. It holds a label and nothing else: the
// content takes a string and optional shortcut keys, so a link, a button or a paragraph cannot get in
// (trap/tooltip-interactive). It never holds anything essential, because it does not open on touch and
// a screen reader may never meet it (trap/tooltip-essential); essential text belongs in the page or in
// a PopoverInfo.
//
// The label also names its trigger: a trigger with no text of its own and no aria-label takes the
// tooltip's string as its aria-label, so what the eye reads and what the screen reader says are one
// string and cannot drift. The inverse surface, 6px soft radius, 12px label, no arrow. It opens after 500ms
// of hover and at once on keyboard focus; inside a TooltipProvider, the next trigger in a toolbar opens
// at once without the fade (trap/tooltip-group-delay).

function TooltipProvider({delay = 500, closeDelay = 0, ...props}: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} closeDelay={closeDelay} {...props}/>;
}

// The label, read from the TooltipContent child at render, so the trigger can be named on the server
// and on the first client render, before anything checks it.
const LabelContext = React.createContext<string | null>(null);

function Tooltip({children, ...props}: TooltipPrimitive.Root.Props) {
  let label: string | null = null;
  React.Children.forEach(children as React.ReactNode, child => {
    if (isPart(child, TooltipContent)) label = readLabel(child.props.children, false).text || null;
  });
  return <LabelContext.Provider value={label}>
    <TooltipPrimitive.Root data-slot="tooltip" {...props}>{children}</TooltipPrimitive.Root>
  </LabelContext.Provider>;
}

/** The text a node would render, from its string children, without rendering it. */
function textOf(node: React.ReactNode): string {
  let text = '';
  React.Children.forEach(node, child => {
    if (typeof child === 'string' || typeof child === 'number') text += child;
    else if (React.isValidElement<{children?: React.ReactNode; 'aria-hidden'?: unknown}>(child) && !child.props['aria-hidden']) text += textOf(child.props.children);
  });
  return text.trim();
}

// As a wrapper around a disabled control, the wrapper takes the pointer and the focus ring.
const wrapperClass = 'rounded-soft [&>:disabled]:pointer-events-none [&>[data-disabled]]:pointer-events-none';

function TooltipTrigger({className, render, children, ...props}: TooltipPrimitive.Trigger.Props) {
  const label = React.useContext(LabelContext);
  // Name a nameless trigger from the label: no aria-label or aria-labelledby on it or its render
  // element, and no text in either's children. A caller's own name always wins.
  const el = React.isValidElement<Record<string, unknown>>(render) ? render : null;
  const named = props['aria-label'] || props['aria-labelledby'] || el?.props['aria-label'] || el?.props['aria-labelledby']
    || textOf(children as React.ReactNode) || textOf(el?.props.children as React.ReactNode);
  const naming = !named && label ? {'aria-label': label, 'data-tooltip-named': ''} : undefined;
  return <TooltipPrimitive.Trigger
    data-slot="tooltip-trigger"
    render={render}
    className={mergeClass(wrapperClass, className)}
    {...naming}
    {...props}
  >{children}</TooltipPrimitive.Trigger>;
}

type TooltipPart = string | number | React.ReactElement | false | null | undefined;
type TooltipChildren = TooltipPart | TooltipPart[];

/** Splits children into the label text and the shortcut, dropping anything else (trap/tooltip-interactive). */
function readLabel(children: TooltipChildren, warn = true) {
  let text = '';
  let shortcut: React.ReactElement | null = null;
  for (const child of React.Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') text += child;
    else if (isPart(child, TooltipShortcut)) shortcut = child;
    else if (warn && child && process.env.NODE_ENV !== 'production') console.error('Tooltip holds a label and a TooltipShortcut only. Move links, buttons and longer text into a Popover.');
  }
  return {text: text.trim(), shortcut};
}

type TooltipContentProps = Omit<TooltipPrimitive.Popup.Props, 'children'> & Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset' | 'collisionPadding'> & {
  /**
   * The label, in sentence case: a verb and its object for an icon button ("Copy run ID"). Text, plus
   * at most a TooltipShortcut; any other element is dropped with a warning in development.
   */
  children: TooltipChildren;
  /** Keys for the action's shortcut, one string per key: ['⌘', 'C']. */
  shortcut?: string[];
};

/**
 * The one tooltip popup: the chip's look, shared by this tooltip, the text hint on Truncate and Relative time, and the
 * sidebar's collapsed-label tooltip. Put it on a popup that is data-surface="inverse", whose channels have flipped, so
 * paper text on ink in light and the reverse in dark. It keeps the soft 6px corner, the one overlay that is not a frame: a
 * label this small would read as a pill at 10px.
 */
const tooltipPopupClass = cn(
  'inline-flex min-h-6 w-fit max-w-(--tooltip-max) items-center gap-2 rounded-soft bg-page px-2 py-1 type-label-sm text-text-1 break-words shadow-overlay',
  'has-data-[slot=tooltip-shortcut]:pe-1',
  'forced-colors:outline-solid forced-colors:outline-1 forced-colors:outline-[CanvasText]',
);

/** How a tooltip popup appears: opacity only, in over --dur-base and out over --dur-fast on the step curve, never growing. */
const tooltipMotionClass = 'transition-opacity duration-(--dur-base) ease-(--ease-step) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--dur-fast) data-instant:duration-0 data-instant:data-ending-style:duration-0 motion-reduce:transition-none';

/**
 * The chip rendered in place, with the popup's look and none of its behaviour: no portal, no timers.
 * Base UI keeps one tooltip open at a time, so a page that shows several open together draws this
 * instead. It is for specimens; a real tooltip is TooltipContent.
 */
function TooltipChip({className, children, shortcut, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {children: string; shortcut?: string[]}) {
  return <div data-slot="tooltip-content" data-surface="inverse" role="presentation" className={cn(tooltipPopupClass, className)} {...props}>
    <span className="min-w-0">{children}</span>
    {shortcut && <TooltipShortcut keys={shortcut}/>}
  </div>;
}

function TooltipContent({className, side = 'top', sideOffset = 6, align = 'center', alignOffset = 0, collisionPadding = 8, children, shortcut, ...props}: TooltipContentProps) {
  const container = useQuartzPortal();
  const {text, shortcut: shortcutChild} = readLabel(children);
  // Nothing to say: no chip at all, rather than an empty 8px one on hover.
  if (!text && !shortcut?.length && !shortcutChild) return null;
  return <TooltipPrimitive.Portal container={container}>
    <TooltipPrimitive.Positioner
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className="isolate z-(--z-overlay)"
    >
      <TooltipPrimitive.Popup
        data-slot="tooltip-content"
        data-surface="inverse"
        className={mergeClass([tooltipPopupClass, tooltipMotionClass], className)}
        {...props}
      >
        <span className="min-w-0">{text}</span>
        {shortcut ? <TooltipShortcut keys={shortcut}/> : shortcutChild}
      </TooltipPrimitive.Popup>
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>;
}

/** Keys in a tooltip, as Kbd caps. One string per key. The popup is data-surface="inverse", which Kbd reads in both themes. */
function TooltipShortcut({keys, className, ...props}: React.ComponentProps<'kbd'> & {keys: string[]}) {
  return <KbdGroup data-slot="tooltip-shortcut" className={cn('shrink-0 flex-nowrap gap-0.5', className)} {...props}>
    {keys.map((key, i) => <Kbd key={i}>{key}</Kbd>)}
  </KbdGroup>;
}

export {Tooltip, TooltipTrigger, TooltipContent, TooltipChip, TooltipProvider, TooltipShortcut, tooltipPopupClass, tooltipMotionClass, type TooltipContentProps};
