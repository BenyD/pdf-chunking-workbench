'use client';

import * as React from 'react';
import {Progress as ProgressPrimitive} from '@base-ui/react/progress';
import {Meter as MeterPrimitive} from '@base-ui/react/meter';
import {cn, mergeClass} from '@/lib/quartz/utils';
import type {Kind} from '@/lib/quartz/kind';
import {Icon, Renew, Checkmark, Close} from '@/components/quartz/icon';
import {Button} from '@/components/quartz/ui/button';
import {InkSlot, StatusArc, statusLabels} from '@/components/quartz/ui/status';

// How far something got, or how full something is. One family for five old components:
//
//   mode="progress" (default): a task moving to done. Base UI Progress, role="progressbar".
//   mode="meter": a level inside a known range (tokens against a plan, seats used). Base UI Meter,
//     role="meter". It never animates on its own and takes warnAt / failAt thresholds.
//   shape: bar (a plain 4px bar) or ring (the old Spinner, and a small determinate ring).
//     ProgressSteps is the old Stepper; ProgressItem and ProgressList the old Progress item.
//
// The bar is a 4px neutral track with one fill from the start edge, drawn in the line step so it reads as a line at
// 3:1, like a chart's. The fill eases to its new width on the standard curve. Indeterminate is a third of the track
// sliding across it; under reduced motion it rests at the start. The ring is one arc from the top that grows for
// determinate, and two opposite arcs turning for indeterminate, which become eight dashes under reduced motion.
// A meter draws its warn threshold as a notch on the track, so the person sees where trouble starts
// before the fill reaches it.

type Mode = 'progress' | 'meter';
type Shape = 'bar' | 'ring';
type Size = 'sm' | 'default' | 'lg';

type ProgressContextValue = {mode: Mode};
const ProgressContext = React.createContext<ProgressContextValue>({mode: 'progress'});

function meterStatus(fraction: number, warnAt: number | null, failAt: number | null) {
  if (failAt !== null && fraction >= failAt) return 'fail' as const;
  if (warnAt !== null && fraction >= warnAt) return 'warn' as const;
  return undefined;
}

type ProgressProps = Omit<ProgressPrimitive.Root.Props, 'value'> & {
  /** 0 to max. null or left out is indeterminate (mode progress only). */
  value?: number | null;
  mode?: Mode;
  shape?: Shape;
  /** Ring only: sm 12px, default 16px, lg 24px. The bar is always 4px. */
  size?: Size;
  kind?: Kind;
  status?: 'warn' | 'fail';
  /** Meter only. Fraction where it turns warn and draws a notch. null never warns. */
  warnAt?: number | null;
  /** Meter only. Fraction where it turns fail. null never fails. */
  failAt?: number | null;
};

function Progress({className, children, value = null, min = 0, max = 100, mode = 'progress', shape = 'bar', size = 'default', kind, status: statusProp, warnAt = 0.8, failAt = 1, ...props}: ProgressProps) {
  const fraction = value === null ? null : Math.min(Math.max((value - min) / (max - min || 1), 0), 1);
  const meter = mode === 'meter';
  const status = statusProp ?? (meter && fraction !== null ? meterStatus(fraction, warnAt, failAt) : undefined);
  const shared = {
    'data-slot': 'progress',
    'data-mode': mode,
    'data-shape': shape,
    'data-size': size,
    'data-kind': status ? undefined : kind,
    'data-status': status,
    // A fixed locale, so the server and the browser format the value the same way. Pass locale to change it.
    locale: 'en-US' as const,
    className: mergeClass(['group/progress flex w-full min-w-0 flex-wrap items-baseline gap-x-3 gap-y-2', shape === 'ring' && 'w-auto flex-nowrap items-center gap-2'], className),
  };
  const visual = shape === 'ring'
    ? <ProgressRingVisual fraction={fraction} size={size}/>
    : <ProgressBar fraction={fraction} meter={meter} warnAt={meter ? warnAt : null}/>;

  if (meter) {
    return <ProgressContext.Provider value={{mode}}>
      <MeterPrimitive.Root value={value ?? 0} min={min} max={max} {...shared} className={shared.className as MeterPrimitive.Root.Props['className']} {...(props as Omit<MeterPrimitive.Root.Props, 'value'>)}>
        {children}{visual}
      </MeterPrimitive.Root>
    </ProgressContext.Provider>;
  }
  return <ProgressContext.Provider value={{mode}}>
    <ProgressPrimitive.Root value={value} min={min} max={max} {...shared} {...props}>
      {children}{visual}
    </ProgressPrimitive.Root>
  </ProgressContext.Provider>;
}

const trackFill = 'bg-cell-quiet forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-1';
const trackHeight = 'h-1';

function Notch({at}: {at: number | null}) {
  if (at === null || at <= 0 || at >= 1) return null;
  return <span
    aria-hidden
    data-slot="progress-notch"
    className="absolute inset-y-0 w-px bg-text-3"
    style={{insetInlineStart: `${at * 100}%`}}
  />;
}

/** One fill from the start edge. With no value, a 30% segment slides along the track. */
function ProgressBar({fraction, meter, warnAt}: {fraction: number | null; meter: boolean; warnAt: number | null}) {
  const Track = meter ? MeterPrimitive.Track : ProgressPrimitive.Track;
  const Indicator = meter ? MeterPrimitive.Indicator : ProgressPrimitive.Indicator;
  return <Track data-slot="progress-track" className={cn('relative block w-full overflow-hidden', trackHeight, trackFill)}>
    {fraction === null
      ? <span
          data-slot="progress-indicator"
          data-indeterminate
          className="absolute inset-y-0 start-0 w-1/3 bg-accent-line forced-colors:bg-[CanvasText] motion-safe:animate-slide"
        />
      : <Indicator data-slot="progress-indicator" className={cn('block h-full bg-accent-line forced-colors:bg-[CanvasText]', !meter && 'transition-[width] duration-(--dur-base) ease-(--ease-step) motion-reduce:transition-none')}/>}
    <Notch at={warnAt}/>
  </Track>;
}

const ringPx: Record<Size, number> = {sm: 12, default: 16, lg: 24};

/** The ring drawing, shared by Progress shape="ring" and ProgressRing. */
function RingSvg({fraction, px}: {fraction: number | null; px: number}) {
  const stroke = px >= 24 ? 2.5 : px >= 16 ? 2 : 1.5;
  const r = (px - stroke) / 2;
  const c = 2 * Math.PI * r;
  const indeterminate = fraction === null;
  return <svg data-slot="progress-ring" viewBox={`0 0 ${px} ${px}`} width={px} height={px} aria-hidden className="shrink-0 -rotate-90" style={{width: px, height: px}}>
    <circle cx={px / 2} cy={px / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-cell-quiet"/>
    {indeterminate
      ? <>
          {/* Two opposite arcs: a determinate ring is always one arc, so a frozen frame never reads as an amount. */}
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" strokeWidth={stroke} strokeDasharray={`${c / 6} ${c / 3}`} className="origin-center stroke-accent-mark animate-spin motion-reduce:hidden"/>
          <circle cx={px / 2} cy={px / 2} r={r} fill="none" strokeWidth={stroke} strokeDasharray={`${c / 16} ${c / 16}`} className="hidden stroke-accent-mark motion-reduce:block"/>
        </>
      : <circle cx={px / 2} cy={px / 2} r={r} fill="none" strokeWidth={stroke} strokeDasharray={`${c * fraction} ${c}`} className="stroke-accent-mark transition-[stroke-dasharray] duration-(--dur-base) ease-(--ease-step) motion-reduce:transition-none"/>}
  </svg>;
}

function ProgressRingVisual({fraction, size}: {fraction: number | null; size: Size}) {
  return <ProgressPrimitive.Track data-slot="progress-track" className="flex shrink-0 items-center">
    <RingSvg fraction={fraction} px={ringPx[size]}/>
  </ProgressPrimitive.Track>;
}

type ProgressRingProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  /** px: 12 in text, 16 in controls and rows, 20 and 24 in panels. */
  size?: 12 | 16 | 20 | 24;
  /** Accessible name. null when a nearby label already says what is waiting, which hides the ring. */
  label?: string | null;
  /** 0 to 1 for a small determinate ring; leave out for the indeterminate one. */
  fraction?: number | null;
};

/**
 * The inline ring for a control, a row or a line of text (the old Spinner). With a label it is a
 * role="progressbar" with no value, which screen readers read as busy; with label={null} it is hidden.
 */
function ProgressRing({size = 16, label = 'Loading', fraction = null, className, ...props}: ProgressRingProps) {
  const a11y = label === null
    ? {'aria-hidden': true as const}
    : {role: 'progressbar' as const, 'aria-label': label, 'aria-valuenow': fraction === null ? undefined : Math.round(fraction * 100), 'aria-valuemin': 0, 'aria-valuemax': 100};
  return <span data-slot="progress-ring-inline" className={cn('inline-flex shrink-0 text-current [--accent-mark:currentColor]', className)} {...a11y} {...props}>
    <RingSvg fraction={fraction} px={size}/>
  </span>;
}

/** The name of what is progressing or measured. */
function ProgressLabel({className, ...props}: ProgressPrimitive.Label.Props) {
  const {mode} = React.useContext(ProgressContext);
  const Label = mode === 'meter' ? MeterPrimitive.Label : ProgressPrimitive.Label;
  return <Label data-slot="progress-label" className={mergeClass('min-w-0 truncate type-label text-text-1', className) as MeterPrimitive.Label.Props['className']} {...(props as MeterPrimitive.Label.Props)}/>;
}

type ProgressValueProps = Omit<MeterPrimitive.Value.Props, 'children'> & {
  /** Formats the reading: {(formatted, value) => `${value} of 50,000`}. value is 0 while indeterminate. */
  children?: ((formattedValue: string, value: number) => React.ReactNode) | null;
};

/** The reading, in tabular figures. */
function ProgressValue({className, children, ...props}: ProgressValueProps) {
  const {mode} = React.useContext(ProgressContext);
  const cls = cn('ms-auto type-label-sm text-text-2', className as string);
  if (mode === 'meter') return <MeterPrimitive.Value data-slot="progress-value" className={cls} {...props}>{children}</MeterPrimitive.Value>;
  return <ProgressPrimitive.Value data-slot="progress-value" className={cls} {...(props as ProgressPrimitive.Value.Props)}>
    {children ? (formatted: string | null, value: number | null) => children(formatted ?? "", value ?? 0) : undefined}
  </ProgressPrimitive.Value>;
}

// ---------- Steps (was Stepper) ----------

type StepState = 'done' | 'current' | 'upcoming' | 'error' | 'pending' | 'waiting';

type StepsContextValue = {
  value: number;
  orientation: 'horizontal' | 'vertical';
  onValueChange?: (step: number) => void;
  linear: boolean;
};

const StepsContext = React.createContext<StepsContextValue | null>(null);
const StepContext = React.createContext<{step: number; state: StepState; disabled: boolean} | null>(null);

function useSteps() {
  const ctx = React.useContext(StepsContext);
  if (!ctx) throw new Error('ProgressStep parts must be inside <ProgressSteps>.');
  return ctx;
}
function useStep() {
  const ctx = React.useContext(StepContext);
  if (!ctx) throw new Error('Step parts must be inside <ProgressStep>.');
  return ctx;
}

type ProgressStepsProps = Omit<React.ComponentProps<'ol'>, 'onChange'> & {
  /** The current step, 1-based. Steps before it are done. */
  value: number;
  onValueChange?: (step: number) => void;
  orientation?: 'horizontal' | 'vertical';
  /** With onValueChange: only steps up to the current one can be picked. */
  linear?: boolean;
};

/** Ordered steps with the current one marked: setup flows, deploy stages. An <ol>, so the order is announced. */
function ProgressSteps({value, onValueChange, orientation = 'horizontal', linear = true, className, ...props}: ProgressStepsProps) {
  const ctx = React.useMemo(() => ({value, onValueChange, orientation, linear}), [value, onValueChange, orientation, linear]);
  return <StepsContext.Provider value={ctx}>
    <ol
      data-slot="progress-steps"
      data-orientation={orientation}
      className={cn('group/steps flex w-full min-w-0', orientation === 'horizontal' ? 'flex-row items-start gap-2' : 'flex-col', className)}
      {...props}
    />
  </StepsContext.Provider>;
}

type ProgressStepProps = React.ComponentProps<'li'> & {
  step: number;
  /** Overrides the state worked out from the value: 'error' for a failed step, 'pending' while it runs. */
  state?: StepState;
  disabled?: boolean;
};

function ProgressStep({step, state: stateProp, disabled = false, className, ...props}: ProgressStepProps) {
  const {value, orientation} = useSteps();
  const state: StepState = stateProp ?? (step < value ? 'done' : step === value ? 'current' : 'upcoming');
  const ctx = React.useMemo(() => ({step, state, disabled}), [step, state, disabled]);
  return <StepContext.Provider value={ctx}>
    <li
      data-slot="progress-step"
      data-state={state}
      aria-current={step === value ? 'step' : undefined}
      className={cn('group/step relative flex min-w-0', orientation === 'horizontal' ? 'flex-1 flex-col' : 'flex-col pb-6 last:pb-0', className)}
      {...props}
    />
  </StepContext.Provider>;
}

/** The pickable part: a button when the steps have onValueChange, a div otherwise. */
function ProgressStepTrigger({className, children, ...props}: React.ComponentProps<'button'>) {
  const {onValueChange, value, linear, orientation} = useSteps();
  const {step, disabled} = useStep();
  // p-1 with -m-1 gives the focus ring 4px of room round the text without moving the layout.
  const base = cn('-m-1 flex min-w-0 p-1 text-start', orientation === 'horizontal' ? 'flex-col items-start gap-2 pe-5' : 'items-start gap-3', className);
  if (!onValueChange) return <div data-slot="progress-step-trigger" className={base}>{children}</div>;
  const blocked = disabled || (linear && step > value);
  return <button
    type="button"
    data-slot="progress-step-trigger"
    disabled={blocked}
    onClick={() => onValueChange(step)}
    className={cn(base, 'rounded-soft decoration-1 underline-offset-4 enabled:hover:[&_[data-slot=progress-step-title]]:underline disabled:cursor-not-allowed')}
    {...props}
  >{children}</button>;
}

const stepWord: Record<StepState, string> = {done: ', done', error: ', failed', pending: ', in progress', current: ', current', upcoming: '', waiting: ', waiting on you'};

/**
 * The 24px box: done is paper with the control edge and a check in text-2 (a finished step is not a person's hand,
 * so no ink fill); current, pending and waiting take the ink edge, which is where the eye should land; upcoming takes
 * the control edge and a text-3 numeral; a failed step takes the fail wash and line and a cross. Numerals are plain
 * sans ("2"), never zero-padded mono.
 */
function ProgressStepIndicator({className, children, ...props}: React.ComponentProps<'span'>) {
  const {step, state} = useStep();
  return <span
    data-slot="progress-step-indicator"
    data-state={state}
    data-status={state === 'error' ? 'fail' : undefined}
    className={cn(
      'frame [--frame-radius:var(--radius-soft)] grid size-6 shrink-0 place-items-center bg-page type-label-sm text-text-1 data',
      'data-[state=done]:text-text-2 data-[state=done]:[--frame-color:var(--line-control)] data-[state=current]:[--frame-color:var(--ink)] data-[state=pending]:[--frame-color:var(--ink)] data-[state=waiting]:[--frame-color:var(--ink)]',
      'data-[state=upcoming]:text-text-3 data-[state=upcoming]:[--frame-color:var(--line-control)]',
      'data-[state=error]:bg-accent-wash data-[state=error]:[--frame-color:var(--accent-line)]',
      className,
    )}
    {...props}
  >
    {children ?? (state === 'done' ? <Icon icon={Checkmark} size={12}/>
      : state === 'error' ? <Icon icon={Close} size={12}/>
      : state === 'pending' ? <ProgressRing size={12} label={null}/>
      : String(step))}
    <span className="sr-only">{stepWord[state]}</span>
  </span>;
}

/** The step's name. A step waiting on a person carries the ink slot after it. */
function ProgressStepTitle({className, children, ...props}: React.ComponentProps<'span'>) {
  const {state} = useStep();
  return <span data-slot="progress-step-title" className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 type-label text-text-1 group-data-[state=upcoming]/step:text-text-2', className)} {...props}>
    {children}{state === 'waiting' && <InkSlot size="sm">{statusLabels.waiting}</InkSlot>}
  </span>;
}

function ProgressStepDescription({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="progress-step-description" className={cn('mt-1 block type-body-sm text-text-3', className)} {...props}/>;
}

/** Holds the title and description beside the indicator. */
function ProgressStepText({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="progress-step-text" className={cn('flex min-w-0 flex-col group-data-[orientation=vertical]/steps:pt-0.5', className)} {...props}/>;
}

/** The connector after a step: the row rule, turning ink once the step is done. */
function ProgressStepSeparator({className, ...props}: React.ComponentProps<'span'>) {
  const {orientation} = useSteps();
  const {state} = useStep();
  return <span
    aria-hidden
    data-slot="progress-step-separator"
    data-state={state}
    className={cn(
      'block bg-line-row group-last/step:hidden data-[state=done]:bg-ink',
      orientation === 'horizontal'
        ? 'absolute start-8 end-2 top-3 h-px'
        : 'absolute start-3 top-8 bottom-2 w-px -translate-x-1/2 rtl:translate-x-1/2',
      className,
    )}
    {...props}
  />;
}

// ---------- Item (was Progress item) ----------

type ProgressItemStatus = 'queued' | 'running' | 'done' | 'warn' | 'failed' | 'canceled';

type ProgressItemProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  /** The thing being worked on: a file name, an index, a batch. */
  title: React.ReactNode;
  /** One line under the title: size, step, error. */
  detail?: React.ReactNode;
  status: ProgressItemStatus;
  /** 0 to max. null while running is indeterminate. */
  value?: number | null;
  max?: number;
  /** The amount at the end, like "42%" or "8 of 24". Defaults to the percentage while running. */
  amount?: React.ReactNode;
  kind?: Kind;
  onCancel?: () => void;
  onRetry?: () => void;
  /** Names the item in the cancel and retry labels ("Cancel upload of help-center.zip"). */
  label?: string;
};

const itemWord: Record<ProgressItemStatus, string> = {queued: 'Queued', running: 'Running', done: 'Done', warn: 'Partly done', failed: 'Failed', canceled: 'Canceled'};

/** The item's status as a word: running keeps the small turning arc, warn and failed take their text steps. */
function ItemWord({status}: {status: ProgressItemStatus}) {
  return <span
    data-slot="progress-item-status"
    data-status={status === 'failed' ? 'fail' : status === 'warn' ? 'warn' : undefined}
    className={cn('inline-flex shrink-0 items-center gap-1.5 type-label-sm', status === 'failed' ? 'text-fail-text' : status === 'warn' ? 'text-warn-text' : status === 'running' ? 'text-text-1' : 'text-text-3')}
  >
    {status === 'running' && <StatusArc/>}
    {itemWord[status]}
  </span>;
}

/** One task in a list: an upload, an index build, an eval batch. Name, status word, amount, track, cancel or retry. */
function ProgressItem({className, title, detail, status, value = 0, max = 100, amount, kind, onCancel, onRetry, label, ...props}: ProgressItemProps) {
  const active = status === 'running' || status === 'queued';
  const shownAmount = amount ?? (status === 'running' && value !== null ? `${Math.round((value / max) * 100)}%` : null);
  const name = label ?? (typeof title === 'string' ? title : 'task');
  return <div
    data-slot="progress-item"
    data-state={status}
    className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2', className)}
    {...props}
  >
    <div className="flex min-w-0 items-baseline gap-2">
      <span className={cn('truncate type-label', status === 'canceled' && 'text-text-3')}>{title}</span>
      <ItemWord status={status}/>
    </div>
    <div className="flex items-center gap-1">
      {shownAmount !== null && <span className="type-label-sm text-text-2 data">{shownAmount}</span>}
      {active && onCancel && <Button size="icon-sm" variant="ghost" aria-label={`Cancel ${name}`} onClick={onCancel}><Icon icon={Close} size={16}/></Button>}
      {status === 'failed' && onRetry && <Button size="icon-sm" variant="ghost" aria-label={`Retry ${name}`} onClick={onRetry}><Icon icon={Renew} size={16}/></Button>}
    </div>
    {(detail || active) && <div className="col-span-2 flex min-w-0 flex-col gap-1.5">
      {active && <Progress aria-label={`${name} progress`} size="sm" kind={kind} value={status === 'queued' ? 0 : value} max={max}/>}
      {detail && <span className={cn('truncate type-body-sm', status === 'failed' ? 'text-fail-text' : 'text-text-3')}>{detail}</span>}
    </div>}
  </div>;
}

/** A list of progress items, divided by faint lines. */
function ProgressList({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="progress-list" className={cn('flex flex-col [&>[data-slot=progress-item]]:rule-row', className)} {...props}/>;
}

export {
  Progress, ProgressLabel, ProgressValue, ProgressRing,
  ProgressSteps, ProgressStep, ProgressStepTrigger, ProgressStepIndicator, ProgressStepTitle, ProgressStepDescription, ProgressStepText, ProgressStepSeparator,
  ProgressItem, ProgressList, meterStatus,
  type ProgressProps, type ProgressRingProps, type ProgressStepsProps, type ProgressStepProps, type StepState, type ProgressItemProps, type ProgressItemStatus,
};
