'use client';

import {Collapsible as CollapsiblePrimitive} from '@base-ui/react/collapsible';
import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import {useEffect, useRef, useState} from 'react';
import {Icon, ChevronRight, Checkmark, Close, Subtract} from '@/components/quartz/icon';
import {Status, StatusArc} from '@/components/quartz/ui/status';
import type {Kind} from '@/lib/quartz/kind';
import {cn, withDefaults} from '@/lib/quartz/utils';

// What the agent is doing now. One component with three looks, one per moment of a turn:
//
// Plain words throughout. The only shape is the small turning arc that means "running"; a finished turn
// is words, and warn or fail add their word in the reserved hue.
//
// - waiting: the first gap of a turn, before any token, reasoning or tool call. The running arc and a
//   label ("Thinking"). It appears only after `delay` ms and stays at least
//   `minLoader` ms once shown, so a fast reply never flashes a loader for one frame. In a thread, the
//   thinking row draws the agent's turn instead; this loader is for products without the timeline.
// - active: a live phrase ("Running eval") in still text, with the running arc. A phrase holds at least
//   `minDisplay` ms (1000 by default) before the next replaces it; phrases that arrive in between are
//   skipped, so a burst of tools reads as phrases, not flicker. The new phrase cuts in; nothing crossfades.
// - done: a static past-tense label, or a summary of the whole turn ("Refunded 3 orders, ran an eval,
//   1 stopped"), with its word when it warned or failed. Going inactive waits `settle` ms, so a tool that ends and
//   the next that starts read as one live phrase.
//
// In a thread the live state is the running tool row, so a turn needs no Activity at all. ActivityGroup is the
// other piece: a quiet one-line summary ("Worked for 14s", "Looked up 2 orders, searched once") with a chevron that opens
// the rows it stands for, inline at their natural height. Screen readers hear settled phrases only, through one
// polite status region, never every phrase.
//
// A step is a line of a checklist: StepGlyph, a 16px cell that holds the state (the arc while it runs, a check when it
// is done, a red cross when it failed, a grey dash when it was denied or stopped), then the words. Every step has the
// cell, so the verbs of a list share one edge. ActivityGroup leads with its chevron in the same cell, so the rows it opens
// hang under it.

// ---------- Text ----------

type ActivityTextProps = useRender.ComponentProps<'span'> & {
  /** The work is running. Marks the element for state hooks; the text itself stays still. */
  active?: boolean;
};

/** A live phrase. It stays still in its own color; the running arc beside it shows the work is live. */
function ActivityText({active = true, className, render, children, ...props}: ActivityTextProps) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {className: cn(className), children},
      {'data-active': active || undefined} as React.ComponentProps<'span'>,
      props,
    ),
    render,
    state: {slot: 'activity-text', active},
  });
}

// ---------- Phrases ----------

const irregular: Record<string, string> = {
  running: 'ran', reading: 'read', writing: 'wrote', finding: 'found', building: 'built', sending: 'sent',
  getting: 'got', making: 'made', thinking: 'thought', setting: 'set', putting: 'put', cutting: 'cut',
  taking: 'took', giving: 'gave', seeing: 'saw', choosing: 'chose', bringing: 'brought', keeping: 'kept',
  leaving: 'left', holding: 'held', drawing: 'drew', spending: 'spent', splitting: 'split', telling: 'told',
  understanding: 'understood', rewriting: 'rewrote', rerunning: 'reran', rebuilding: 'rebuilt', resetting: 'reset',
  doing: 'did', going: 'went', paying: 'paid', saying: 'said', meeting: 'met', feeding: 'fed', winning: 'won',
  gathering: 'gathered',
};
const vowel = (ch: string | undefined) => !!ch && 'aeiou'.includes(ch);

/** "Searching docs" to "Searched docs". Handles -ing verbs and the irregulars agents use most. */
function pastTense(phrase: string): string {
  const [first, ...rest] = phrase.split(' ');
  const word = first.toLowerCase();
  if (!word.endsWith('ing') || word.length < 5) return phrase;
  const stem = word.slice(0, -3);
  const past = irregular[word] ?? (stem.endsWith('y') && !vowel(stem.at(-2)) ? `${stem.slice(0, -1)}ied` : `${stem}ed`);
  const cased = first[0] === first[0].toUpperCase() ? past[0].toUpperCase() + past.slice(1) : past;
  return [cased, ...rest].join(' ');
}

/** "Refunded 3 orders, ran an eval, 1 stopped". Done parts and trouble counts all join with commas. */
function joinSummary(done: string[], trouble: string[] = []) {
  const head = done.filter(Boolean).join(', ');
  const cased = head ? head[0].toUpperCase() + head.slice(1) : '';
  return [cased, ...trouble.filter(Boolean)].filter(Boolean).join(', ');
}

/** Minimum on-screen time for a phrase. */
const MIN_DISPLAY = 1000;

/** Holds each phrase for `hold` ms and keeps only the newest waiting one. */
function useHeldPhrase(label: string, active: boolean, hold: number) {
  const [shown, setShown] = useState(label);
  const shownAt = useRef(0);
  useEffect(() => {
    if (label === shown) return;
    if (!active) { setShown(label); shownAt.current = Date.now(); return; }
    const wait = Math.max(0, hold - (Date.now() - shownAt.current));
    const timer = setTimeout(() => { setShown(label); shownAt.current = Date.now(); }, wait);
    return () => clearTimeout(timer);
  }, [label, shown, active, hold]);
  return shown;
}

/** True while active, and for `settle` ms after, so a quick stop and start never flickers. */
function useSettled(active: boolean, settle: number) {
  const [live, setLive] = useState(active);
  useEffect(() => {
    if (active) { setLive(true); return; }
    const timer = setTimeout(() => setLive(false), settle);
    return () => clearTimeout(timer);
  }, [active, settle]);
  return active || live;
}

/**
 * Anti-flicker for loaders: turns true only after `show` has held for `delay` ms, and once true stays
 * true for at least `min` ms. A reply that lands in 80ms never shows the loader at all.
 */
function useAntiFlicker(show: boolean, delay = 150, min = 500) {
  const [visible, setVisible] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (show && !visible) {
      const t = setTimeout(() => { since.current = Date.now(); setVisible(true); }, delay);
      return () => clearTimeout(t);
    }
    if (!show && visible) {
      const t = setTimeout(() => setVisible(false), Math.max(0, min - (Date.now() - since.current)));
      return () => clearTimeout(t);
    }
  }, [show, visible, delay, min]);
  return visible;
}

// ---------- Activity ----------

type ActivityEnd = 'ok' | 'warn' | 'fail' | 'stopped';

type ActivityLabels = {
  /** The loader's label when `label` is not set. */
  thinking?: string;
  /** The done label of a stopped turn with no doneLabel. */
  stopped?: string;
  /** Read after the done label when the work warned, failed or stopped, unless the label already says so. */
  warnEnd?: string;
  failEnd?: string;
  stoppedEnd?: string;
};

const activityLabels: Required<ActivityLabels> = {
  thinking: 'Thinking', stopped: 'Stopped', warnEnd: 'with a warning', failEnd: 'failed', stoppedEnd: 'stopped',
};

const activityVariants = cva('relative flex w-fit max-w-full min-w-0 items-center text-start text-text-1', {
  variants: {
    size: {
      default: 'gap-2 type-label',
      sm: 'gap-1.5 type-body-sm',
    },
  },
  defaultVariants: {size: 'default'},
});

type ActivityProps = Omit<React.ComponentProps<'span'>, 'children'> & VariantProps<typeof activityVariants> & {
  /** The phrase for the work in progress, an -ing verb and its object: "Searching docs". */
  label?: string;
  /** Work is running now. */
  active?: boolean;
  /** Nothing has arrived yet this turn: shows the first-wait loader with `label` (default "Thinking"). */
  waiting?: boolean;
  /** The finished phrase or turn summary. Defaults to the past tense of the last live phrase. */
  doneLabel?: string;
  /** How the work ended. warn and fail take the reserved hues; stopped is idle ink. */
  status?: ActivityEnd;
  /** Agents own their activity, so it defaults to agent. */
  kind?: Kind;
  /** Minimum ms a live phrase stays before the next replaces it. */
  minDisplay?: number;
  /** Ms to wait after going inactive before settling into the done label. */
  settle?: number;
  /** Ms the turn must wait before the loader shows. */
  delay?: number;
  /** Minimum ms the loader stays once shown. */
  minLoader?: number;
  /**
   * Owns a polite status region that reads the settled phrase. Pass false inside a Conversation, which
   * makes the one announcement per turn end itself.
   */
  announce?: boolean;
  /** The default words, for another language. */
  labels?: ActivityLabels;
};

function Activity({
  label, active = false, waiting = false, doneLabel, status = 'ok', kind = 'agent', size = 'default',
  minDisplay = MIN_DISPLAY, settle = 400, delay = 150, minLoader = 500, announce = true, labels, className, ...props
}: ActivityProps) {
  const words = withDefaults(activityLabels, labels);
  const loader = useAntiFlicker(waiting, delay, minLoader);
  const live = useSettled(active, settle);
  const phrase = useHeldPhrase(label ?? '', live, minDisplay);
  const state = loader ? 'waiting' : live ? 'active' : waiting || (!label && !doneLabel) ? 'idle' : 'done';
  // The new phrase replaces the old one in place: a cut, never a crossfade.
  const text = state === 'waiting' ? (label ?? words.thinking)
    : state === 'active' ? phrase
      : state === 'idle' ? ''
        : (doneLabel ?? (status === 'stopped' ? words.stopped : pastTense(phrase)));

  // The end word is skipped when the summary already says it ("1 stopped").
  const end = {ok: '', warn: words.warnEnd, fail: words.failEnd, stopped: words.stoppedEnd}[status];
  const said = end && !text.toLowerCase().includes(end.toLowerCase().replace(/^with a /, '')) ? `, ${end}` : '';
  const announced = state === 'done' ? `${text}${said}` : state === 'waiting' ? text : '';
  const moving = state === 'active' || state === 'waiting';
  const trouble = state === 'done' && (status === 'warn' || status === 'fail');
  const region = announce && <span role="status" className="sr-only">{announced}</span>;
  const shared = {'data-slot': 'activity', 'data-state': state, 'data-kind': kind, 'data-size': size, 'aria-busy': moving || undefined};

  return <span {...shared} className={cn(activityVariants({size}), className)} {...props}>
    {moving && <StatusArc/>}
    <ActivityText active={moving} className="min-w-0 truncate">{text}</ActivityText>
    {trouble && <Status status={status} className="shrink-0" aria-hidden/>}
    {/* One polite region: the loader's label and the settled phrase. Live phrases are not read out. */}
    {region}
  </span>;
}

// ---------- Group ----------

type ActivityItem = {id: string; label: string; status: 'pending' | 'running' | 'ok' | 'fail' | 'stopped' | 'denied' | 'waiting'};

/**
 * Which item the header follows: the newest running one, else the last that did not fail, else the
 * last. A failed call never becomes the headline while something else succeeded after it.
 */
function pickActivity<T extends Pick<ActivityItem, 'status'>>(items: readonly T[]): T | undefined {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].status === 'running' || items[i].status === 'pending' || items[i].status === 'waiting') return items[i];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].status !== 'fail') return items[i];
  return items.at(-1);
}

type StepState = 'running' | 'done' | 'fail' | 'stopped';

/**
 * The state of one step in a 16px cell: the arc while it runs, a check in text-3 when it is done, a red cross when it
 * failed, a grey dash when it was denied or stopped. The cell is always there, so verbs line up whatever the state.
 * Hidden from assistive tech: the row says its state in words.
 */
function StepGlyph({state, className}: {state: StepState; className?: string}) {
  return <span aria-hidden data-slot="step-glyph" data-state={state} className={cn('flex size-4 shrink-0 items-center justify-center', className)}>
    {state === 'running' ? <StatusArc className="text-text-2"/>
      : state === 'done' ? <Icon icon={Checkmark} size={12} className="text-text-3"/>
        : state === 'fail' ? <Icon icon={Close} size={12} className="text-fail-text"/>
          : <Icon icon={Subtract} size={12} className="text-text-3"/>}
  </span>;
}

/** The chevron of a row that opens, in a 16px cell. A row that does not open draws nothing at its end. */
function Disclosure({open, end = false}: {open: boolean; end?: boolean}) {
  if (end && !open) return null;
  return <span
    aria-hidden
    data-slot="disclosure"
    data-end={end || undefined}
    data-filled={open || undefined}
    className="flex size-4 shrink-0 items-center justify-center text-text-3"
  >
    {open && <Icon icon={ChevronRight} size={12} className="transition-transform duration-(--dur-fast) ease-(--ease-step) group-data-panel-open/row:rotate-90 motion-reduce:transition-none rtl:-scale-x-100 rtl:group-data-panel-open/row:-rotate-90"/>}
  </span>;
}

/**
 * The shared line of a tool row and a group summary: 32px, a 16px cell at the start, then the words with the time right
 * after them. It is only as wide as what it says, the way a chat client shows a step, never a full-width bar with the
 * time pushed to the far edge. It bleeds 8px into the gutter so the cell sits on the text's left edge and the hover wash
 * has room. Only a row that opens gets the wash.
 */
const rowVariants = cva('group/row -mx-2 flex max-w-[calc(100%+var(--spacing)*4)] min-w-0 items-center gap-2 self-start rounded-soft px-2 text-start type-body-sm focus-visible:focus-ring-inset pointer-coarse:min-h-11', {
  variants: {
    size: {default: 'min-h-(--row-sm)', sm: 'min-h-(--control-sm)'},
    opens: {true: 'transition-colors duration-(--dur-fast) ease-(--ease-step) hover:bg-hover active:bg-pressed', false: ''},
  },
  defaultVariants: {size: 'default', opens: true},
});

type ActivityGroupProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  /** The one line that stands for the rows: "Worked for 14s", "Looked up 2 orders, searched once". */
  summary: React.ReactNode;
  /** The end of the line: a duration in text-3, or a failed count. Rows are arriving shows the running arc when this is empty. */
  meta?: React.ReactNode;
  /** Rows are arriving. */
  live?: boolean;
  /** The rows. Hidden until the line opens. */
  children?: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  size?: 'default' | 'sm';
};

/**
 * A summary line over rows. It starts closed: the chevron opens the rows inline at their natural height, indented under
 * the words (in a message, on the text column), with no frame and no inner scroll. Meant for a finished turn
 * ("Worked for 14s") or the calls that came before the live one.
 */
function ActivityGroup({summary, meta, live = false, open, defaultOpen = false, onOpenChange, size = 'default', className, children, ...props}: ActivityGroupProps) {
  return <CollapsiblePrimitive.Root
    data-slot="activity-group"
    data-live={live || undefined}
    open={open}
    defaultOpen={defaultOpen}
    onOpenChange={onOpenChange}
    className={cn('flex min-w-0 flex-col', className)}
    {...props}
  >
    <CollapsiblePrimitive.Trigger data-slot="activity-group-trigger" className={rowVariants({size})}>
      <Disclosure open/>
      <span data-slot="activity-group-summary" className="min-w-0 truncate text-text-2">{summary}</span>
      <span data-slot="activity-group-meta" className="flex shrink-0 items-center gap-2 text-text-3 data">
        {meta ?? (live ? <StatusArc/> : null)}
      </span>
    </CollapsiblePrimitive.Trigger>
    <CollapsiblePrimitive.Panel data-slot="activity-group-content" className="flex min-w-0 flex-col">
      {children}
    </CollapsiblePrimitive.Panel>
  </CollapsiblePrimitive.Root>;
}

export {
  Activity, ActivityText, ActivityGroup, Disclosure, StepGlyph, pastTense, joinSummary, pickActivity, useAntiFlicker,
  useHeldPhrase, MIN_DISPLAY, activityVariants, rowVariants,
  type ActivityProps, type ActivityLabels, type ActivityTextProps, type ActivityEnd, type ActivityItem, type ActivityGroupProps, type StepState,
};
