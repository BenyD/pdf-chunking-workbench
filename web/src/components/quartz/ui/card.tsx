'use client';

import {Collapsible as CollapsiblePrimitive} from '@base-ui/react/collapsible';
import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import {createContext, useContext} from 'react';
import {Icon, ChevronDown} from '@/components/quartz/icon';
import {Badge} from '@/components/quartz/ui/badge';
import {ButtonSize} from '@/components/quartz/ui/button';
import type {Kind} from '@/lib/quartz/kind';
import {cn, mergeClass} from '@/lib/quartz/utils';

// Quartz's card is the frame: paper, one 1px grey edge, the 10px frame corner. Inside it only
// row rules: a 40px header over a rule, the body, a footer under a rule. It is paper like the page, so it sets no
// data-surface and nothing inside flips; a well inside it (code, output) is grey on its own. With `kind`, a collapsible
// card's header carries the kind's badge. Never a Card inside a Card. A Card is a working surface (a big table or
// stream, a trace, a log, code, a form, one object's detail; anything that scrolls, filters or is edited); a widget or a
// decision is a Panel (ui/panel.tsx). A widget is a Panel and a working surface is a Card; never a Card inside a Panel
// or a Panel inside a Card.
//
// `collapsible` folds the body under the header (was Collapsible card): a tool call's input, a span's
// attributes, a settings group. CardTrigger is the header's button; CardAction sits beside it, outside
// it, so there is never a button inside a button. A folded body stays searchable: it is hidden with
// hidden="until-found", so the browser's find-in-page and a link to anything inside it open the card
// and scroll to the match, instead of finding nothing.

const CardContext = createContext<{collapsible: boolean; kind?: Kind}>({collapsible: false});

const cardVariants = cva(
  [
    'group/card relative flex flex-col overflow-hidden bg-page text-text-1 frame [a]:hover:bg-hover',
    'forced-colors:outline forced-colors:outline-1',
  ],
  // --card-spacing pads the body only; the header and footer keep the frame's 16px inline padding.
  {
    variants: {
      size: {
        sm: '[--card-spacing:var(--space-3)]',
        default: '[--card-spacing:var(--space-4)]',
        lg: '[--card-spacing:var(--space-6)]',
      },
    },
    defaultVariants: {size: 'default'},
  },
);

type CardOwnProps = VariantProps<typeof cardVariants> & {
  /** The kind the card belongs to. On a collapsible card it marks the header. */
  kind?: Kind;
};

type CardProps =
  | (useRender.ComponentProps<'div'> & CardOwnProps & {collapsible?: false})
  | (CollapsiblePrimitive.Root.Props & CardOwnProps & {
    /** Fold the body under the header. */
    collapsible: true;
  });

function Card(props: CardProps) {
  if (props.collapsible) {
    const {className, size = 'default', kind, collapsible: _, ...rest} = props;
    return <CardContext.Provider value={{collapsible: true, kind}}>
      <CollapsiblePrimitive.Root
        data-slot="card"
        data-collapsible=""
        data-size={size}
        data-kind={kind}
        className={mergeClass(cardVariants({size}), className)}
        {...rest}
      />
    </CardContext.Provider>;
  }
  const {className, size = 'default', kind, render, collapsible: _, ...rest} = props;
  return <StaticCard className={className} size={size} kind={kind} render={render} {...rest}/>;
}

function StaticCard({className, size, kind, render, ...props}: useRender.ComponentProps<'div'> & CardOwnProps) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {className: cn(cardVariants({size}), className)},
      {'data-slot': 'card', 'data-size': size, 'data-kind': kind} as React.ComponentProps<'div'>,
      props,
    ),
    render,
    state: {slot: 'card', size},
  });
}

function CardHeader({className, ...props}: React.ComponentProps<'div'>) {
  const {collapsible} = useContext(CardContext);
  return <div
    data-slot="card-header"
    className={cn(
      // The shared 40px header (frame-head) over a row rule. With a description it grows to two lines on a grid, the
      // action spanning both; with none it is one line, the action centred at the end.
      collapsible
        ? 'flex min-h-10 items-center gap-2 rule-row has-data-[slot=card-action]:pe-2'
        : 'frame-head rule-row *:data-[slot=card-action]:ms-auto has-data-[slot=card-description]:grid has-data-[slot=card-description]:auto-rows-min has-data-[slot=card-description]:content-center has-data-[slot=card-description]:grid-rows-[auto_auto] has-data-[slot=card-description]:gap-y-0.5 has-data-[slot=card-description]:py-2.5 has-data-[slot=card-action]:has-data-[slot=card-description]:grid-cols-[1fr_auto]',
      className,
    )}
    {...props}
  />;
}

/** The header's button on a collapsible card: holds the title and meta, and turns the caret. */
function CardTrigger({className, children, ...props}: CollapsiblePrimitive.Trigger.Props) {
  const {kind} = useContext(CardContext);
  return <CollapsiblePrimitive.Trigger
    data-slot="card-trigger"
    className={mergeClass([
      // With no CardAction after it, the trigger runs to the card's edge, so its hover and focus ring do too.
      'group/card-trigger @container/card-trigger flex min-h-10 min-w-0 flex-1 items-center gap-3 self-stretch rounded-none py-2 px-4 not-last:pe-2 text-start',
      // Base UI marks a disabled trigger with aria-disabled (and disabled on a native button), not data-disabled.
      'transition-colors duration-(--dur-fast) ease-(--ease-step) hover:not-aria-disabled:not-disabled:bg-hover aria-disabled:text-text-disabled disabled:text-text-disabled',
      'focus-visible:focus-ring-inset',
    ], className)}
    {...props}
  >
    {children}
    {kind && <Badge kind={kind} size="sm"/>}
    <Icon icon={ChevronDown} size={16} className="ms-auto shrink-0 text-text-3 group-aria-disabled/card-trigger:text-text-disabled group-disabled/card-trigger:text-text-disabled transition-none group-data-panel-open/card-trigger:rotate-180"/>
  </CollapsiblePrimitive.Trigger>;
}

function CardTitle({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="card-title" className={cn('min-w-0 type-label text-text-1 group-data-collapsible/card:truncate', className)} {...props}/>;
}

/**
 * Quiet text after the title in a collapsible header: a count, a duration, a status word. Stays visible folded.
 * Under 240px of header it leaves the screen but stays in the trigger's name, so the title keeps its room.
 */
function CardMeta({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="card-meta" className={cn('shrink-0 type-label text-text-3 data @max-[15rem]/card-trigger:sr-only', className)} {...props}/>;
}

function CardDescription({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('type-body-sm text-text-2', className)} {...props}/>;
}

/** Actions in the header. Beside the trigger on a collapsible card, never inside it. */
function CardAction({className, children, ...props}: React.ComponentProps<'div'>) {
  const {collapsible} = useContext(CardContext);
  return <div data-slot="card-action" className={cn(collapsible ? 'flex shrink-0 items-center gap-1' : 'frame-head-action col-start-2 row-span-2 row-start-1 self-center justify-self-end', className)} {...props}><ButtonSize size="xs">{children}</ButtonSize></div>;
}

function CardContent({className, children, ...props}: React.ComponentProps<'div'>) {
  const {collapsible} = useContext(CardContext);
  if (collapsible) return <CollapsiblePrimitive.Panel
    data-slot="card-content"
    hiddenUntilFound
    className="overflow-hidden"
  >
    <div className={cn('flex flex-col gap-3 p-(--card-spacing) type-body text-text-2', className)} {...props}>{children}</div>
  </CollapsiblePrimitive.Panel>;
  return <div data-slot="card-content" className={cn('flex flex-col gap-3 p-(--card-spacing) type-body', className)} {...props}>{children}</div>;
}

function CardFooter({className, children, ...props}: React.ComponentProps<'div'>) {
  // Buttons here are sm (28px) unless named otherwise, 8px from each edge of the 44px footer.
  return <div data-slot="card-footer" className={cn('frame-foot justify-end rule-top', className)} {...props}><ButtonSize size="sm">{children}</ButtonSize></div>;
}

export {Card, CardHeader, CardTrigger, CardFooter, CardTitle, CardMeta, CardAction, CardDescription, CardContent, cardVariants, type CardProps};
