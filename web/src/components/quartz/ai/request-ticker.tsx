'use client';

import {useEffect, useRef, useState} from 'react';
import {CodeTag} from '@/components/quartz/ui/badge';
import {StatusArc} from '@/components/quartz/ui/status';
import {formatCount, formatDurations} from '@/lib/quartz/format';
import {cn, withDefaults} from '@/lib/quartz/utils';

// The requests an HTTP or MCP tool call makes, in the row grammar of a tool call's well. "Calling api" with a counter
// hides what matters, which request failed; the ticker shows it.
//
// While the call runs it shows the newest `max` requests, newest last, 32px each with no rules between them, since it
// is a stream, not a table. A new request cuts in at the bottom and the oldest cuts out at the top, with no slide, and
// each set holds at least 300ms so a burst reads as a few frames, not a blur. A request still in flight shows the arc
// where its status code goes. The live ticker is hidden from assistive tech: the activity phrase already says what is
// happening.
//
// Once the call is done it lists every request as a real <ol>, capped at `cap` rows with a "Show more" row. It sits in a
// tool call's well (px-3 py-2), so the "Show more" row bleeds 12px and 8px to the well's edges, like the output cap's.
//
// Method and status are CodeTags: a 20px type-tag box with a 1px line. The line carries the class, the text stays
// ink: 2xx and 3xx take the control line, 4xx the warn line, 5xx the fail line. Duration is sans with tabular figures.

type TickerRequest = {
  id: string;
  /** GET, POST, or an MCP method name. */
  method?: string;
  /** The path, URL or tool the request went to. */
  target: string;
  /** The status code. Leave out while the request is in flight. */
  code?: number | string;
  /** Ms the request took. */
  duration?: number;
};

type RequestTickerLabels = {
  /** The row that opens the rest of a finished list. */
  showMore?: (count: number) => string;
  showLess?: string;
  /** The list's name. */
  requests?: string;
};

const tickerLabels: Required<RequestTickerLabels> = {
  showMore: n => `Show ${formatCount(n)} more`,
  showLess: 'Show less',
  requests: 'Requests',
};

type RequestTickerProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  items: readonly TickerRequest[];
  /** Requests are still arriving: show the newest `max`. */
  live?: boolean;
  /** Rows shown while live. */
  max?: number;
  /** Rows shown once done, before "Show more". */
  cap?: number;
  /** Ms a set of rows holds before the next replaces it while live. */
  hold?: number;
  labels?: RequestTickerLabels;
};

/** The class of a status code: ok for 1xx to 3xx, warn for 4xx, fail for 5xx and anything unreadable. */
function codeClass(code: number | string | undefined): 'ok' | 'warn' | 'fail' | undefined {
  if (code === undefined || code === '') return undefined;
  const n = Number(code);
  if (!Number.isFinite(n)) return 'fail';
  return n >= 500 ? 'fail' : n >= 400 ? 'warn' : 'ok';
}

/** How many requests there are and how many failed. A 4xx and a 5xx both count as failed. */
function countRequests(items: readonly TickerRequest[]) {
  const failed = items.filter(r => codeClass(r.code) === 'warn' || codeClass(r.code) === 'fail').length;
  return {head: `${formatCount(items.length)} ${items.length === 1 ? 'request' : 'requests'}`, failed};
}

/** "42 requests, 2 failed": the detail of a finished call, as text. */
function summarizeRequests(items: readonly TickerRequest[]) {
  const {head, failed} = countRequests(items);
  return failed ? `${head}, ${failed} failed` : head;
}

/** The same summary for a row, with the failed count in the fail text so it reads as trouble. */
function RequestSummary({items}: {items: readonly TickerRequest[]}) {
  const {head, failed} = countRequests(items);
  return failed ? <>{head}, <span data-slot="request-ticker-failed" className="text-fail-text">{failed} failed</span></> : head;
}

/** The newest `max` items, held for at least `hold` ms per set while live, so a burst never blurs. */
function useHeldWindow<T>(items: readonly T[], max: number, live: boolean, hold: number) {
  const [shown, setShown] = useState(() => items.slice(-max));
  const at = useRef(0);
  const latest = useRef(items);
  latest.current = items;
  useEffect(() => {
    const next = () => { at.current = Date.now(); setShown(latest.current.slice(-max)); };
    if (!live) { next(); return; }
    const wait = Math.max(0, hold - (Date.now() - at.current));
    if (!wait) { next(); return; }
    const timer = setTimeout(next, wait);
    return () => clearTimeout(timer);
  }, [items, max, live, hold]);
  return shown;
}

function Row({request, live, as: As = 'div'}: {request: TickerRequest; live: boolean; as?: 'div' | 'li'}) {
  const status = codeClass(request.code);
  return <As
    data-slot="request-ticker-row"
    data-status={status === 'warn' || status === 'fail' ? status : undefined}
    className="flex h-(--row-sm) min-w-0 items-center gap-3"
  >
    <span className="flex w-16 shrink-0">{request.method && <CodeTag>{request.method}</CodeTag>}</span>
    <span dir="ltr" className="min-w-0 flex-1 truncate text-start type-tag text-text-1">{request.target}</span>
    <span className="flex w-10 shrink-0 justify-end">{status ? <CodeTag code={request.code} status={status === 'ok' ? 'neutral' : status}/> : live && <StatusArc/>}</span>
    <span className="w-14 shrink-0 text-end type-body-sm text-text-3 data">{request.duration !== undefined && formatMs(request.duration)}</span>
  </As>;
}

/** 31ms, 2.1s. */
const formatMs = (ms: number) => formatDurations([Number.isFinite(ms) ? Math.max(0, ms) : 0]).values[0];

/** The well's last row: a full-width 32px button that bleeds to the well's edges (12px, 8px below), under a row rule. */
function ShowMoreRow({className, ...props}: Omit<React.ComponentProps<'button'>, 'type'>) {
  return <button
    type="button"
    className={cn('-mx-3 -mb-2 mt-1 flex h-(--row-sm) items-center self-stretch px-3 text-start type-label-sm text-text-2 rule-top transition-colors duration-(--dur-fast) ease-(--ease-step) hover:bg-hover hover:text-text-1 focus-visible:focus-ring-inset', className)}
    {...props}
  />;
}

function RequestTicker({items, live = false, max = 3, cap = 10, hold = 300, labels, className, ...props}: RequestTickerProps) {
  const words = withDefaults(tickerLabels, labels);
  const recent = useHeldWindow(items, max, live, hold);
  const [all, setAll] = useState(false);
  if (live) {
    return <div data-slot="request-ticker" data-live="" aria-hidden className={cn('flex min-w-0 flex-col', className)} {...props}>
      {recent.map(r => <Row key={r.id} request={r} live/>)}
    </div>;
  }
  const hidden = all ? 0 : Math.max(0, items.length - cap);
  const shown = hidden ? items.slice(0, cap) : items;
  return <div data-slot="request-ticker" className={cn('flex min-w-0 flex-col', className)} {...props}>
    <ol aria-label={words.requests} className="flex min-w-0 flex-col">
      {shown.map(r => <Row key={r.id} as="li" request={r} live={false}/>)}
    </ol>
    {items.length > cap && <ShowMoreRow data-slot="request-ticker-more" onClick={() => setAll(v => !v)}>{all ? words.showLess : words.showMore(hidden)}</ShowMoreRow>}
  </div>;
}

export {RequestTicker, RequestSummary, ShowMoreRow, summarizeRequests, codeClass, type RequestTickerProps, type RequestTickerLabels, type TickerRequest};
