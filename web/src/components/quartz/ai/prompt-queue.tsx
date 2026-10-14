'use client';

import * as React from 'react';
import {Icon, ArrowDown, ArrowUp, Edit, Close} from '@/components/quartz/icon';
import {Button} from '@/components/quartz/ui/button';
import {fieldControlVariants} from '@/components/quartz/ui/field';
import {Status} from '@/components/quartz/ui/status';
import {cn, mergeRefs, withDefaults} from '@/lib/quartz/utils';
import {isComposing} from '@/components/quartz/ai/prompt-input/codec';

// The stack of follow-ups above the composer: messages written while the agent works. They send in order
// when the turn ends, and a failed head holds the rest until it is retried, edited or removed.
//
// The queue joins the composer: render it directly above PromptInput and the two share one line. The queue is a
// frame in the control line with no bottom edge and square bottom corners; the composer's top edge closes it.

type QueuedMessage = {
  id: string;
  text: string;
  /** queued by default. sending while it is dispatched; failed holds the queue until retried or edited. */
  status?: 'queued' | 'sending' | 'failed';
  /** Why it failed, shown under the row. */
  error?: string;
};

type PromptQueueLabels = {
  /** The line over the list, from the count and whether a failed head holds it. */
  summary?: (count: number, halted: boolean) => string;
  /** The status word at the start of each row. */
  queued?: string;
  sending?: string;
  failed?: string;
  retry?: string;
  sendNow?: string;
  /** The Edit button's name, from the message. */
  edit?: (text: string) => string;
  /** The field's name while a row is edited. */
  editField?: string;
  save?: string;
  cancel?: string;
  moveUp?: string;
  moveDown?: string;
  remove?: string;
  /** Under a failed row, after its error (or `notSent` when it has none). */
  notSent?: string;
  held?: string;
};

const queueLabels: Required<PromptQueueLabels> = {
  summary: (count, halted) => `${count} queued, ${halted ? 'held because the first one failed' : 'sent in order when the agent finishes'}`,
  queued: 'Queued',
  sending: 'Sending',
  failed: 'Failed',
  retry: 'Retry',
  sendNow: 'Send now',
  edit: text => `Edit "${text.slice(0, 40)}"`,
  editField: 'Edit queued message',
  save: 'Save',
  cancel: 'Cancel',
  moveUp: 'Move up',
  moveDown: 'Move down',
  remove: 'Remove from queue',
  notSent: 'Not sent.',
  held: 'The queue waits until you retry, edit or remove it.',
};

type PromptQueueProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  items: QueuedMessage[];
  onEdit?: (id: string, text: string) => void;
  onSendNow?: (id: string) => void;
  onRemove?: (id: string) => void;
  /** Retries the failed head. */
  onRetry?: (id: string) => void;
  /** Moves a message to a new index. Alt+ArrowUp and Alt+ArrowDown on a row do the same. */
  onMove?: (id: string, index: number) => void;
  /** Controls which row is being edited, for ArrowUp-on-empty in the composer. */
  editingId?: string | null;
  onEditingChange?: (id: string | null) => void;
  /** Where focus goes when the queue can no longer hold it (its last row was sent or removed): usually the
   *  composer, through its handle's focus(). */
  returnFocus?: () => void;
  /** The words and button names, for another language. */
  labels?: PromptQueueLabels;
};

function QueueRow({item, index, count, editing, setEditing, onEdit, onSendNow, onRemove, onRetry, onMove, words}: {
  item: QueuedMessage;
  index: number;
  count: number;
  editing: boolean;
  setEditing: (on: boolean) => void;
  words: Required<PromptQueueLabels>;
} & Pick<PromptQueueProps, 'onEdit' | 'onSendNow' | 'onRemove' | 'onRetry' | 'onMove'>) {
  const [draft, setDraft] = React.useState(item.text);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const editRef = React.useRef<HTMLButtonElement>(null);
  const wasEditing = React.useRef(editing);
  React.useEffect(() => { if (editing) { setDraft(item.text); requestAnimationFrame(() => inputRef.current?.select()); } }, [editing, item.text]);
  // Save, Cancel or Escape removes the field that had focus: hand it to this row's Edit button.
  React.useLayoutEffect(() => {
    const active = document.activeElement;
    if (wasEditing.current && !editing && (!active || active === document.body || !active.isConnected)) editRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const save = () => { const text = draft.trim(); if (text && text !== item.text) onEdit?.(item.id, text); setEditing(false); };
  const status = item.status ?? 'queued';
  const sending = status === 'sending';
  const failed = status === 'failed';

  if (editing) {
    return <li data-slot="prompt-queue-item" data-index={index} data-state="editing" className="flex min-h-(--row) min-w-0 flex-wrap items-center gap-1.5 py-1.5 ps-4 pe-1.5 rule-row">
      <input
        ref={inputRef}
        value={draft}
        aria-label={words.editField}
        onChange={event => setDraft(event.target.value)}
        onKeyDown={event => {
          if (isComposing(event)) return;
          if (event.key === 'Enter') { event.preventDefault(); save(); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(false); }
        }}
        className={fieldControlVariants({size: 'sm', className: 'min-w-0 flex-1 basis-40'})}
      />
      <span className="flex shrink-0 gap-1.5">
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{words.cancel}</Button>
        <Button size="sm" onClick={save}>{words.save}</Button>
      </span>
    </li>;
  }

  return <li
    data-slot="prompt-queue-item"
    data-index={index}
    data-state={status}
    data-status={failed ? 'fail' : undefined}
    onKeyDown={event => {
      if (!event.altKey || !onMove || sending) return;
      if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); onMove(item.id, index - 1); }
      if (event.key === 'ArrowDown' && index < count - 1) { event.preventDefault(); onMove(item.id, index + 1); }
    }}
    // No hover fill on a row: only its buttons hover.
    className={cn('@container/queue-row flex min-w-0 flex-col py-1.5 ps-4 pe-1.5 rule-row', failed && 'bg-accent-wash')}
  >
    {/* Under 384px the actions move to a line of their own, so the message keeps its width. */}
    <div className="flex min-h-(--control-sm) min-w-0 flex-wrap items-center gap-x-2.5 @sm/queue-row:flex-nowrap">
      <Status status={failed ? 'fail' : sending ? 'running' : 'queued'} className="w-20 shrink-0">{failed ? words.failed : sending ? words.sending : words.queued}</Status>
      <span className="min-w-0 flex-1 truncate type-body text-text-1" title={item.text}>{item.text}</span>
      <span className="flex shrink-0 basis-full items-center justify-end @sm/queue-row:basis-auto">
        {(onRetry || onSendNow) && <span data-slot="prompt-queue-primary" className="flex w-25 shrink-0 justify-end">
          {failed && onRetry
            ? <Button size="sm" variant="secondary" onClick={() => onRetry(item.id)} className="w-full">{words.retry}</Button>
            : onSendNow && !failed && <Button size="sm" variant="ghost" disabled={sending} pending={sending} pendingLabel={words.sending} onClick={() => onSendNow(item.id)} className="w-full">{words.sendNow}</Button>}
        </span>}
        {onEdit && <Button ref={editRef} size="icon-sm" variant="ghost" aria-label={words.edit(item.text)} disabled={sending} onClick={() => setEditing(true)}><Icon icon={Edit} size={16}/></Button>}
        {onMove && count > 1 && <>
          <Button size="icon-sm" variant="ghost" aria-label={words.moveUp} aria-keyshortcuts="Alt+ArrowUp" disabled={sending || index === 0} onClick={() => onMove(item.id, index - 1)}><Icon icon={ArrowUp} size={16}/></Button>
          <Button size="icon-sm" variant="ghost" aria-label={words.moveDown} aria-keyshortcuts="Alt+ArrowDown" disabled={sending || index === count - 1} onClick={() => onMove(item.id, index + 1)}><Icon icon={ArrowDown} size={16}/></Button>
        </>}
        {onRemove && <Button size="icon-sm" variant="ghost" aria-label={words.remove} disabled={sending} onClick={() => onRemove(item.id)}><Icon icon={Close} size={16}/></Button>}
      </span>
    </div>
    {failed && <p className="ps-22.5 pb-1 type-body-sm break-words text-text-2">{item.error ?? words.notSent} {words.held}</p>}
  </li>;
}

/** Messages written while the agent works. They send in order when the turn ends; a failed head holds the rest. */
function PromptQueue({items, onEdit, onSendNow, onRemove, onRetry, onMove, editingId, onEditingChange, returnFocus, labels, className, ref, ...props}: PromptQueueProps) {
  const words = withDefaults(queueLabels, labels);
  const id = React.useId();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const rootRefs = React.useMemo(() => mergeRefs(rootRef, ref), [ref]);
  const [innerEditing, setInnerEditing] = React.useState<string | null>(null);
  const editing = editingId !== undefined ? editingId : innerEditing;
  const setEditing = (next: string | null) => { if (editingId === undefined) setInnerEditing(next); onEditingChange?.(next); };
  // The row that last held focus. Retry, Remove, Send now and a sent head all remove the focused button;
  // focus then goes to the same place in the list, or back to the composer when the list is gone.
  const lastIndex = React.useRef<number | null>(null);
  React.useEffect(() => {
    const away = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) lastIndex.current = null; };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, []);
  React.useLayoutEffect(() => {
    if (lastIndex.current === null) return;
    // Lost means on the body, detached, or on a control that just became disabled (Chromium moves focus off
    // it only at the next frame).
    const active = document.activeElement as HTMLElement | null;
    const lost = !active || active === document.body || !active.isConnected || (!!rootRef.current?.contains(active) && active.matches(':disabled'));
    if (!lost) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('[data-slot="prompt-queue-item"]') ?? [];
    const row = rows[Math.min(lastIndex.current, rows.length - 1)];
    const target = row?.querySelector<HTMLElement>('input, button:not(:disabled)');
    if (target) { target.focus(); return; }
    lastIndex.current = null;
    returnFocus?.();
  });
  if (!items.length) return null;
  const halted = items[0]?.status === 'failed';
  return <div
    ref={rootRefs}
    data-slot="prompt-queue"
    data-state={halted ? 'halted' : 'waiting'}
    onFocus={event => { const row = (event.target as HTMLElement).closest<HTMLElement>('[data-index]'); if (row) lastIndex.current = Number(row.dataset.index); }}
    onBlur={event => { const next = event.relatedTarget as Node | null; if (next && !event.currentTarget.contains(next)) lastIndex.current = null; }}
    className={cn(// The frame's radius is one variable, so the square bottom is set there; a rounded-b-none beside the frame utility would fight it.
    'relative flex min-w-0 flex-col bg-page frame [--frame-color:var(--line-control)] [--frame-radius:var(--radius-frame)_var(--radius-frame)_0_0] before:border-b-0', className)}
    {...props}
  >
    <p id={id} className="flex min-h-(--row) items-center px-4 py-1 type-body-sm text-text-2 data rule-row" aria-live="polite">{words.summary(items.length, halted)}</p>
    <ol aria-labelledby={id} className="flex flex-col">
      {items.map((item, i) => <QueueRow
        key={item.id}
        item={item}
        index={i}
        count={items.length}
        editing={editing === item.id}
        setEditing={on => setEditing(on ? item.id : null)}
        onEdit={onEdit}
        onSendNow={onSendNow}
        onRemove={onRemove}
        onRetry={onRetry}
        onMove={onMove}
        words={words}
      />)}
    </ol>
  </div>;
}

export {PromptQueue, type QueuedMessage, type PromptQueueProps, type PromptQueueLabels};
