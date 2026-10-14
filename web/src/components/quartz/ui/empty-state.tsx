'use client';

import {createContext, useContext, useRef, useState} from 'react';
import {cva, type VariantProps} from 'class-variance-authority';
import {cn} from '@/lib/quartz/utils';
import {Icon, Renew} from '@/components/quartz/icon';
import {Button} from '@/components/quartz/ui/button';
import {CodeTag} from '@/components/quartz/ui/badge';

// What a region shows when it has nothing else to show, plus the old Error card as
// reason="error". The four reasons share one shape (title, description, actions) and differ in what
// they say and how loud they are:
//   empty      nothing here yet; the first action creates it
//   no-results a search or filter matched nothing; the action clears it
//   no-access  the person cannot see this; the action asks for access
//   error      it failed to load or run; role="alert", the reserved fail (or warn) hue, a status
//              word, the request ID, and Retry
//
// It sits where the first row would have been: top-left of the body, under the header or toolbar, never centred
// in a void. When a query or filter emptied the list, write it back in the title as an EmptyQuery code tag:
// "No runs match `timeout`". In a table, list or log it is variant="plain", sharing that frame; standalone
// (variant="framed") it draws its own frame, and an error frame names its trouble in red text.
//
// The considered detail is Retry. EmptyRetry runs the caller's promise, keeps its box while it runs,
// and when the retry fails again it says so in place: "Retry 2 failed at 14:03:12". Retrying a dead
// endpoint never looks like the button did nothing.

type EmptyReason = 'empty' | 'no-results' | 'no-access' | 'error';
/** @deprecated Use EmptyReason. */
type EmptyKind = EmptyReason;

/** The status of an error Empty, so EmptyCode draws its edge in the status line. */
const EmptyTone = createContext<'fail' | 'warn' | undefined>(undefined);

const emptyVariants = cva('group/empty flex w-full min-w-0 flex-col items-start gap-3 text-start text-text-1', {
  variants: {
    variant: {
      // Standalone: its own frame. A failing one shows its status word in red. card is the deprecated name for framed.
      framed: 'relative bg-page frame',
      card: 'relative bg-page frame',
      plain: '',
    },
    size: {
      default: 'px-4 py-6',
      sm: 'gap-2 px-4 py-4',
    },
  },
  defaultVariants: {variant: 'framed', size: 'default'},
});

type EmptyProps = React.ComponentProps<'div'> & VariantProps<typeof emptyVariants> & {
  /** Why there is nothing. error sets role="alert" and the fail hue. */
  reason?: EmptyReason;
  /** @deprecated Use reason. */
  kind?: EmptyReason;
  /** @deprecated Quartz empty states always sit top-left; this does nothing. */
  align?: 'start' | 'center';
  /** error only: fail (default) for errors, warn for something that ran partly (a timeout, partial results). */
  status?: 'fail' | 'warn';
};

function Empty({className, reason: reasonProp, kind, status, variant = 'framed', size = 'default', align, role, ...props}: EmptyProps) {
  const reason = reasonProp ?? kind ?? 'empty';
  const error = reason === 'error';
  const tone = error ? (status ?? 'fail') : undefined;
  if (align === 'center' && process.env.NODE_ENV !== 'production') warnCentred();
  return <EmptyTone.Provider value={tone}>
    <div
      data-slot="empty"
      data-reason={reason}
      data-size={size}
      data-status={tone}
      role={role ?? (error ? 'alert' : undefined)}
      className={cn(emptyVariants({variant, size}), className)}
      {...props}
    />
  </EmptyTone.Provider>;
}

let warned = false;
function warnCentred() {
  if (warned) return;
  warned = true;
  console.warn('Quartz empty states sit top-left; align="center" renders as start.');
}

function EmptyHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="empty-header" className={cn('flex max-w-(--measure-short) flex-col gap-1 has-[>[data-slot=empty-media]]:flex-row has-[>[data-slot=empty-media]]:flex-wrap has-[>[data-slot=empty-media]]:items-center has-[>[data-slot=empty-media]]:gap-x-2 has-[>[data-slot=empty-media]]:[&>[data-slot=empty-description]]:basis-full', className)} {...props}/>;
}

/** Optional. A bare 16px icon in muted ink before the title, on its line; no tile and no hue. Most leave it out. */
function EmptyMedia({className, children, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="empty-media"
    className={cn('flex shrink-0 items-center justify-center text-text-3 [&_svg]:size-4', className)}
    {...props}
  >{children}</div>;
}

function EmptyTitle({className, ...props}: React.ComponentProps<'h3'>) {
  return <h3 data-slot="empty-title" className={cn('type-heading-xs text-pretty text-text-1 group-data-[size=sm]/empty:type-label', className)} {...props}/>;
}

function EmptyDescription({className, ...props}: React.ComponentProps<'p'>) {
  return <p
    data-slot="empty-description"
    className={cn('type-body-sm text-pretty text-text-2 [&_a]:text-text-1 [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4', className)}
    {...props}
  />;
}

/** The actions: the first one that gets the person out of the empty state, and at most one quieter one. */
function EmptyContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="empty-content" className={cn('flex w-full max-w-sm min-w-0 flex-wrap items-center gap-2 pt-1', className)} {...props}/>;
}

/** error: the status word in red text (amber for a warn state), as in "Failed", "Timed out", "Error 502". */
function EmptyStatus({className, children, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="empty-status" className={cn('flex items-center gap-2', className)} {...props}>
    <span className="type-state-word text-fail-text group-data-[status=warn]/empty:text-warn-text">{children}</span>
  </div>;
}

/**
 * error: the code or request ID as a CodeTag. One click selects all of it, for pasting into a support thread. Its
 * edge is the fail line in a failed state and the warn line in a warn one.
 */
function EmptyCode({className, ...props}: React.ComponentProps<'span'>) {
  const tone = useContext(EmptyTone);
  return <CodeTag
    data-slot="empty-code"
    fill="outline"
    status={tone}
    className={cn('h-auto min-h-5 shrink whitespace-normal break-all select-all', className)}
    {...props}
  />;
}

/** The query or filter that emptied the list, written back as a CodeTag inside the title: No runs match `timeout`. */
function EmptyQuery({className, ...props}: React.ComponentProps<'span'>) {
  return <CodeTag
    data-slot="empty-query"
    fill="outline"
    className={cn('h-auto min-h-5 shrink align-baseline whitespace-normal break-all', className)}
    {...props}
  />;
}

const clock = (d: Date) => d.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false});

type EmptyRetryProps = Omit<React.ComponentProps<typeof Button>, 'onClick' | 'pending' | 'children'> & {
  /** Runs the retry. Reject (or throw) when it fails again. */
  onRetry: () => Promise<unknown>;
  children?: React.ReactNode;
};

/**
 * Retry that reports itself. Pending while the promise runs (the box and label hold), and after a
 * failed retry a status line under it: "Retry 2 failed at 14:03:12", counting the person's presses (the
 * original load is not one). A success leaves it to the caller, who replaces the Empty with the content and
 * moves focus to it (rule empty-retry-focus).
 */
function EmptyRetry({onRetry, children = 'Retry', variant = 'secondary', size = 'sm', className, ...props}: EmptyRetryProps) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState<{attempt: number; at: string} | null>(null);
  const attempts = useRef(0);
  const run = async () => {
    if (pending) return;
    setPending(true);
    try {
      await onRetry();
      setFailed(null);
    } catch {
      attempts.current += 1;
      setFailed({attempt: attempts.current, at: clock(new Date())});
    } finally {
      setPending(false);
    }
  };
  return <span data-slot="empty-retry" className="inline-flex flex-col gap-1">
    <Button variant={variant} size={size} pending={pending} pendingLabel="Retrying" onClick={run} className={className} {...props}>
      <Icon icon={Renew} size={16}/>{children}
    </Button>
    <span role="status" data-slot="empty-retry-status" className="min-h-lh type-body-sm text-text-2 data empty:min-h-0">
      {failed && `Retry ${failed.attempt} failed at ${failed.at}`}
    </span>
  </span>;
}

export {Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent, EmptyStatus, EmptyCode, EmptyQuery, EmptyRetry, emptyVariants, type EmptyProps, type EmptyReason, type EmptyKind, type EmptyRetryProps};
