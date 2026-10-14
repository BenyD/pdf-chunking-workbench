import {cva, type VariantProps} from 'class-variance-authority';
import {cn} from '@/lib/quartz/utils';

// Where a piece of work stands: idle, queued, running, ok, warn, fail, or waiting on a person. The status is a
// word in sentence case. Nothing else carries it, so it reads in grayscale, in forced colors and aloud.
//
// Ink draws queued and running; ok is plain secondary text and idle a step lighter. Warn takes the amber text step and fail the red
// text step, both 4.5:1 or better on paper and on the well. Running keeps one small mark before the word: a 3/4
// arc, 10px like every status icon, that turns smoothly once a second. Under reduced motion
// it stops and stays a static arc, so it still reads as running. A frame marked data-offscreen pauses it too.
// Waiting renders the InkSlot, a paper label with a light edge, since the work is in a person's hands. Inside a
// DataTable or data grid row it drops to the plain ink word instead: a long column of boxes would be many
// InkSlots in one card, and the rule is one. A short list in a panel (Item, static Table) keeps its one box.
//
// variant="field" is kept so old call sites compile and renders as plain: the big moment belongs to the frame
// (data-status="fail" on it, the word in its header).
//
// live: speaks only when work settles or stops on a person. A hidden status region holds the word for ok, warn,
// fail and waiting and stays empty for idle, queued and running, so a screen reader hears one word when a run
// ends, not every hop on the way. Server-safe: the region is plain markup, no effect or timer.
//
// InkSlot, beside it: a paper label with a light edge for the one thing waiting on a person, in ink text.
// At most one per card or panel, so it is the one thing there that asks for a person.

type Status = 'idle' | 'queued' | 'running' | 'ok' | 'warn' | 'fail' | 'waiting';

const statuses = ['idle', 'queued', 'running', 'ok', 'warn', 'fail', 'waiting'] as const satisfies readonly Status[];

const statusLabels: Record<Status, string> = {
  idle: 'Idle',
  queued: 'Queued',
  running: 'Running',
  ok: 'OK',
  warn: 'Warning',
  fail: 'Failed',
  waiting: 'Waiting on you',
};

/** Severity for sorting a status column: fail first, then what waits on a person, idle last. Higher is worse. */
const statusRank: Record<Status, number> = {fail: 6, waiting: 5, warn: 4, running: 3, queued: 2, ok: 1, idle: 0};

/** ok, warn and fail end a piece of work, and waiting stops it on a person; the others are on the way. */
const settled = (status: Status) => status === 'ok' || status === 'warn' || status === 'fail' || status === 'waiting';

const wordVariants = cva('relative inline-flex items-start gap-1.5 type-state-word text-text-1 data', {
  variants: {
    variant: {
      plain: 'data-[status=ok]:text-text-2 data-[status=idle]:text-text-3 data-[status=warn]:text-warn-text data-[status=fail]:text-fail-text',
      /** @deprecated Renders as plain. */
      field: 'data-[status=ok]:text-text-2 data-[status=idle]:text-text-3 data-[status=warn]:text-warn-text data-[status=fail]:text-fail-text',
    },
  },
  defaultVariants: {variant: 'plain'},
});

type StatusProps = Omit<React.ComponentProps<'span'>, 'children'> & VariantProps<typeof wordVariants> & {
  status?: Status;
  /** @deprecated A no-op kept so older call sites compile: a Status is always the word. */
  display?: 'word';
  /** Replaces the default word. `true` keeps it. */
  label?: string | true;
  /** Speak when the status settles on ok, warn or fail; stay quiet for queued and running. */
  live?: boolean;
  /** Replaces the default word, like `label`. Keep it to 1 to 3 words. */
  children?: React.ReactNode;
};

function Status({status = 'idle', variant = 'plain', label, live, display: _display, className, children, ...props}: StatusProps) {
  if (process.env.NODE_ENV !== 'production' && variant === 'field') console.warn('Status: variant="field" renders as plain. Put data-status on the frame and the word in its header.');
  const word = children ?? (typeof label === 'string' ? label : statusLabels[status]);
  // The region is always in the DOM, so a change from empty to the word is what gets announced.
  const region = live ? <span role="status" className="sr-only">{settled(status) ? (typeof word === 'string' ? word : statusLabels[status]) : ''}</span> : null;
  if (status === 'waiting') return <span data-slot="status" data-status={status} className={cn('inline-flex', className)} {...props}>
    <InkSlot aria-hidden={live ? true : undefined} className={inRow}>{word}</InkSlot>
    {region}
  </span>;
  return <span
    data-slot="status"
    data-status={status}
    data-variant={variant}
    className={cn(wordVariants({variant}), className)}
    {...props}
  >
    {status === 'running' && <FirstLine><StatusArc/></FirstLine>}
    <span data-slot="status-word" aria-hidden={live && settled(status) ? true : undefined} className="min-w-0 [overflow-wrap:anywhere]">{word}</span>
    {region}
  </span>;
}

// In a DataTable or DataGrid row the waiting label is the ink word with no box.
const inRow = [
  'in-data-[slot=data-table]:h-auto in-data-[slot=data-table]:rounded-none in-data-[slot=data-table]:bg-transparent in-data-[slot=data-table]:px-0 in-data-[slot=data-table]:shadow-none',
  'in-data-[slot=data-grid-row]:h-auto in-data-[slot=data-grid-row]:rounded-none in-data-[slot=data-grid-row]:bg-transparent in-data-[slot=data-grid-row]:px-0 in-data-[slot=data-grid-row]:shadow-none',
].join(' ');

/** A box one line tall, so the arc beside wrapped text centres on the first line, not the block. */
function FirstLine({children}: {children: React.ReactNode}) {
  return <span data-slot="status-arc-line" className="flex h-(--line-box) shrink-0 items-center">{children}</span>;
}

/**
 * The running arc on its own, for a dense spot with no room for the word. Pass `name` so the arc is
 * announced; without it the arc is hidden from assistive tech and the word must sit beside it.
 */
function StatusArc({name, className, ...props}: Omit<React.ComponentProps<'span'>, 'children'> & {name?: string}) {
  return <span
    data-slot="status-arc"
    data-status="running"
    role={name ? 'img' : undefined}
    aria-label={name || undefined}
    aria-hidden={name ? undefined : true}
    className={cn('relative box-border inline-block size-2.5 shrink-0 rounded-full border border-current border-t-transparent motion-safe:animate-run in-data-offscreen:[animation-play-state:paused] forced-colors:[forced-color-adjust:none] forced-colors:border-[CanvasText] forced-colors:border-t-transparent', className)}
    {...props}
  />;
}

const inkSlotVariants = cva('inline-flex shrink-0 items-center rounded-inner bg-page whitespace-nowrap text-text-1 shadow-[inset_0_0_0_1px_var(--line-control)] data forced-colors:border forced-colors:border-transparent', {
  variants: {
    size: {
      default: 'h-(--control-xs) px-2 type-label',
      sm: 'h-(--tag) px-1.5 type-label-sm',
    },
  },
  defaultVariants: {size: 'default'},
});

type InkSlotProps = React.ComponentProps<'span'> & VariantProps<typeof inkSlotVariants>;

/**
 * The ink slot: the one thing in a card or panel that waits on a person, as a paper label with a light edge and ink text ("Waiting on you",
 * "Your review", "3 waiting on you"). A label, never a button: the action sits beside it. One to three words, at most
 * one per card or panel. 24px tall, or 20px at `size="sm"` for a dense row. In forced colors a transparent border keeps its box.
 */
function InkSlot({size = 'default', className, ...props}: InkSlotProps) {
  return <span data-slot="ink-slot" data-size={size} className={cn(inkSlotVariants({size}), className)} {...props}/>;
}

export {Status, StatusArc, InkSlot, inkSlotVariants, type InkSlotProps, statuses, statusLabels, statusRank, wordVariants as statusWordVariants, type Status as StatusValue, type StatusProps};
