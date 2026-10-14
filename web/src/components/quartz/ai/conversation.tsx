'use client';

import {createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Icon, ArrowDown, ArrowUp} from '@/components/quartz/icon';
import {Button} from '@/components/quartz/ui/button';
import {InkSlot, Status, statusLabels} from '@/components/quartz/ui/status';
import {DiffCount} from '@/components/quartz/ai/tool-call';
import {AgentTurn, Message, MessageBubble, MessageBubbleContent, MessageContent, MessageDivider, MessageHeader, MessageTime} from '@/components/quartz/ai/message';
import {cn, mergeClass, mergeRefs, withDefaults} from '@/lib/quartz/utils';

// A streaming thread anchored to the bottom (was Message scroller).
//
// The detach model is gestures only. The view follows new content while it is attached, and only a
// real gesture lets go: a wheel or touch upward, a drag on the scrollbar, or ArrowUp, PageUp or Home
// while focus is in the thread. Content growth, a tool row that opens, an image that loads, a layout
// shift and our own scrollTo calls never detach it. It counts as at the end within 30px. It re-attaches
// only when the person scrolls back to the end themselves: a downward gesture (wheel, swipe, key or
// scrollbar drag) whose scroll moves toward the end and lands within 5px, or the End key. A scroll event caused by a
// stream append, a resize or the detach gesture's own first frame never re-attaches.
// A wheel inside a nested scroller (a code block, a reasoning pane) detaches only once that scroller
// is at its top, at overscroll. Selecting text pauses the follow until the selection collapses.
//
// The thread is a scroll column on paper, not a frame. Jump to latest appears once the view is more than max(400px, the viewport's
// height) from the end; while a waiting call is out of view it reads "Waiting on you" and goes there instead. The
// person's own send snaps to the bottom. While streaming, the content keeps a height floor, so
// a loader that gives way to shorter text never clamps the scroll position and jumps the view.
// A fixed tail slot holds the loader and then the turn's actions in one reserved box.
//
// Rows are typed: user, assistant, thinking (the agent's turn the moment the person sends: a running "Thinking"; the name is read aloud, not drawn), retry with a
// countdown, diff summary (once idle), error, and dividers for compaction and interruption. An abort is
// an "Interrupted" divider, never an error. Structurally equal rows keep their identity, so a delta
// re-renders only the row it touched. Long threads skip layout for offscreen rows with
// content-visibility; the last user row and the last row are always laid out. Prepending history keeps
// the row under the reader's eye where it was.

/** Px from the end within which the view counts as at the end. */
const STICK = 30;
/** Px from the end within which a detached view re-attaches. */
const REATTACH = 5;
/** Ms after a downward gesture during which a scroll that reaches the end re-attaches. */
const DOWN_GESTURE_MS = 800;

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True when `el` or a scroller between it and `root` can still scroll up, so the wheel belongs to it. */
function nestedCanScrollUp(target: EventTarget | null, root: HTMLElement) {
  let el = target instanceof Element ? target : null;
  while (el && el !== root) {
    if (el instanceof HTMLElement && el.scrollHeight > el.clientHeight + 1) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollTop > 0) return true;
    }
    el = el.parentElement;
  }
  return false;
}

type StickOptions = {
  /** Follow new content while attached. */
  enabled?: boolean;
  /** The element whose growth is followed. Defaults to the scroller's first child. */
  content?: React.RefObject<HTMLElement | null>;
};

/**
 * The gesture-only stick-to-bottom model, for the thread and for any pane that streams (reasoning,
 * terminal). Returns whether the view is attached, its distance from the end, and controls.
 *
 * It subscribes to whatever element the ref holds after each commit, so a pane that mounts later (a
 * collapsible panel that opens) is followed from the moment it appears. Pass the returned `ref` as the
 * element's ref when the element can mount after the hook's owner.
 */
function useStickToBottom(ref: React.RefObject<HTMLElement | null>, {enabled = true, content}: StickOptions = {}) {
  const attached = useRef(true);
  const paused = useRef(false);
  const follows = useRef(enabled);
  follows.current = enabled;
  /** The scrollTop at the last scroll event, to tell a scroll toward the end from one away from it. */
  const lastTop = useRef(0);
  /** When the person last asked to move down: a wheel or swipe down, a key toward the end, a scrollbar drag. */
  const downAt = useRef(-Infinity);
  const dragging = useRef(false);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [distance, setDistance] = useState(0);
  const [isAttached, setAttached] = useState(true);

  const setAttach = useCallback((value: boolean) => { attached.current = value; setAttached(value); }, []);

  const callbackRef = useCallback((el: HTMLElement | null) => { ref.current = el; setNode(el); }, [ref]);
  // An object ref passed straight to the element: pick up the node after each commit.
  useLayoutEffect(() => { if (ref.current !== node) setNode(ref.current); });

  const measure = useCallback((fromScroll = false) => {
    const el = ref.current;
    if (!el) return;
    const d = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    const movedDown = el.scrollTop > lastTop.current;
    if (fromScroll) lastTop.current = el.scrollTop;
    // Re-attach only when the person scrolled back to the end themselves: a scroll event that moved
    // toward the end, within a downward gesture, landing within REATTACH. A stream append, a resize
    // or the detach gesture's own first scroll event never re-attaches.
    if (!attached.current && fromScroll && movedDown && d <= REATTACH && (dragging.current || performance.now() - downAt.current < DOWN_GESTURE_MS)) setAttach(true);
    setDistance(d);
  }, [ref, setAttach]);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = ref.current;
    if (!el) return;
    setAttach(true);
    el.scrollTo({top: el.scrollHeight, behavior: behavior === 'smooth' && !reducedMotion() ? 'smooth' : 'auto'});
  }, [ref, setAttach]);

  useEffect(() => {
    const el = node;
    if (!el) return;
    lastTop.current = el.scrollTop;
    const follow = () => {
      if (follows.current && attached.current && !paused.current) el.scrollTop = el.scrollHeight;
      measure();
    };
    const resize = new ResizeObserver(follow);
    resize.observe(el);
    const inner = content?.current ?? (el.firstElementChild as HTMLElement | null);
    if (inner) resize.observe(inner);
    const mutations = new MutationObserver(follow);
    mutations.observe(el, {childList: true, subtree: true, characterData: true});

    const detach = () => { if (attached.current) setAttach(false); };
    const down = () => { downAt.current = performance.now(); };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && !nestedCanScrollUp(e.target, el)) detach();
      else if (e.deltaY > 0) down();
    };
    let touchY = 0;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? 0;
      if (y > touchY + 2 && !nestedCanScrollUp(e.target, el)) detach();
      else if (y < touchY - 2) down();
      touchY = y;
    };
    const onTouchEnd = () => down();
    // A press in the scrollbar gutter: the target is the scroller and the point is past its client box.
    const onPointerDown = (e: PointerEvent) => {
      if (e.target !== el) return;
      const box = el.getBoundingClientRect();
      const inBar = document.dir === 'rtl' || getComputedStyle(el).direction === 'rtl' ? e.clientX < box.left + (el.offsetWidth - el.clientWidth) : e.clientX > box.left + el.clientWidth;
      if (inBar) { detach(); dragging.current = true; }
    };
    const onPointerUp = () => { if (dragging.current) { dragging.current = false; down(); } };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, [contenteditable="true"], select')) return;
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home' || (e.key === ' ' && e.shiftKey)) detach();
      // End asks for the end outright: re-attach and go there, even while content keeps growing.
      else if (e.key === 'End') { e.preventDefault(); scrollToEnd(); }
      else if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') down();
    };
    const onScroll = () => measure(true);
    const onSelection = () => {
      const sel = document.getSelection();
      paused.current = !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode);
      if (!paused.current) follow();
    };
    const onVisible = () => { if (!document.hidden) follow(); };

    el.addEventListener('wheel', onWheel, {passive: true});
    el.addEventListener('touchstart', onTouchStart, {passive: true});
    el.addEventListener('touchmove', onTouchMove, {passive: true});
    el.addEventListener('touchend', onTouchEnd, {passive: true});
    el.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    el.addEventListener('keydown', onKey);
    el.addEventListener('scroll', onScroll, {passive: true});
    document.addEventListener('selectionchange', onSelection);
    document.addEventListener('visibilitychange', onVisible);
    follow();
    return () => {
      resize.disconnect();
      mutations.disconnect();
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('scroll', onScroll);
      document.removeEventListener('selectionchange', onSelection);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [node, content, measure, setAttach, scrollToEnd]);

  // A new stream on an attached view, or a pane that just mounted, starts at the end.
  useEffect(() => {
    if (!enabled || !node || !attached.current) return;
    node.scrollTop = node.scrollHeight;
  }, [node, enabled]);

  const detachView = useCallback(() => setAttach(false), [setAttach]);
  return {ref: callbackRef, attached: isAttached, distance, atEnd: distance <= STICK, scrollToEnd, detach: detachView};
}

// ---------- Context ----------

type ConversationStatus = 'idle' | 'streaming' | 'stopped' | 'error';

type ConversationContextValue = {
  viewportRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  status: ConversationStatus;
  attached: boolean;
  distance: number;
  atEnd: boolean;
  /** Smooth scroll to the end and re-attach. */
  scrollToEnd: (behavior?: ScrollBehavior) => void;
  /** The person sent: jump to the end at once and re-attach, whatever they were reading. */
  snap: () => void;
  /** Stop following, so a scroll to an earlier row stays there. The waiting jump calls it. */
  detach: () => void;
};

const Ctx = createContext<ConversationContextValue | null>(null);

/** The thread's state and controls, from any part inside it or inside its Provider. */
function useConversation() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useConversation must be used inside Conversation or ConversationProvider');
  return ctx;
}

function State({children, status}: {children: React.ReactNode; status: ConversationStatus}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stick = useStickToBottom(viewportRef, {content: contentRef});
  const {scrollToEnd, attached, distance, atEnd, detach} = stick;
  const snap = useCallback(() => scrollToEnd('auto'), [scrollToEnd]);
  const value = useMemo(() => ({viewportRef, contentRef, status, attached, distance, atEnd, scrollToEnd, snap, detach}), [status, attached, distance, atEnd, scrollToEnd, snap, detach]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Lifts the state above the root, so a composer outside it can call snap() on send. */
function ConversationProvider({children, status = 'idle'}: {children: React.ReactNode; status?: ConversationStatus}) {
  return <State status={status}>{children}</State>;
}

type ConversationProps = React.ComponentProps<'div'> & {
  /** idle, streaming, stopped or error. Drives aria-busy, the height floor and the one announcement. Inside a ConversationProvider, set it there instead. */
  status?: ConversationStatus;
};

function Conversation({className, status = 'idle', ...props}: ConversationProps) {
  const outer = useContext(Ctx);
  const root = <div
    data-slot="conversation"
    data-status={outer ? outer.status : status}
    className={cn('group/conversation relative flex size-full min-h-0 flex-col overflow-hidden', className)}
    {...props}
  />;
  return outer ? root : <State status={status}>{root}</State>;
}

type ConversationViewportLabels = {
  /** The one announcement when a turn ends: complete, stopped or failed. The thread's name is aria-label. */
  complete?: string;
  stopped?: string;
  failed?: string;
};

const viewportLabels: Required<ConversationViewportLabels> = {complete: 'Response complete', stopped: 'Stopped', failed: 'Response failed'};

function ConversationViewport({className, 'aria-label': ariaLabel = 'Conversation', labels, children, ref, ...props}: React.ComponentProps<'div'> & {labels?: ConversationViewportLabels}) {
  const {viewportRef, status, attached} = useConversation();
  const words = withDefaults(viewportLabels, labels);
  const announcements: Partial<Record<ConversationStatus, string>> = {idle: words.complete, stopped: words.stopped, error: words.failed};
  const viewportRefs = useMemo(() => mergeRefs(viewportRef, ref), [viewportRef, ref]);
  // One announcement per turn end: complete, stopped or failed. Not a live region per row.
  const [said, setSaid] = useState('');
  const prev = useRef(status);
  useEffect(() => {
    if (prev.current === 'streaming' && status !== 'streaming') setSaid(announcements[status] ?? '');
    if (status === 'streaming') setSaid('');
    prev.current = status;
    // The words are read only as a turn ends; a new labels object must not announce again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  return <>
    <div
      ref={viewportRefs}
      data-slot="conversation-viewport"
      data-attached={attached}
      role="log"
      aria-live="off"
      aria-label={ariaLabel}
      aria-busy={status === 'streaming' || undefined}
      tabIndex={0}
      className={cn(
        'size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-gutter:stable] [scrollbar-width:thin] focus-visible:focus-ring-inset',
        className,
      )}
      {...props}
    >{children}</div>
    <span role="status" className="sr-only">{said}</span>
  </>;
}

function ConversationContent({className, style, children, ref, ...props}: React.ComponentProps<'div'>) {
  const {contentRef, viewportRef, status, attached} = useConversation();
  const contentRefs = useMemo(() => mergeRefs(contentRef, ref), [contentRef, ref]);
  const [floor, setFloor] = useState(0);

  // Height floor: while streaming the content never shrinks, so scrollTop is never clamped mid-turn.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (status !== 'streaming') { setFloor(0); return; }
    const ro = new ResizeObserver(() => setFloor(f => Math.max(f, el.scrollHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [contentRef, status]);

  // Prepend anchor: remember the first row on screen and keep it where it was when rows are added above.
  const anchor = useRef<{key: string; top: number} | null>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const el = contentRef.current;
    if (!viewport || !el) return;
    const prevAnchor = anchor.current;
    if (prevAnchor && !attached) {
      const row = el.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(prevAnchor.key)}"]`);
      if (row) {
        const delta = row.offsetTop - prevAnchor.top;
        if (delta) viewport.scrollTop += delta;
      }
    }
    const rows = el.querySelectorAll<HTMLElement>('[data-row-key]');
    const first = [...rows].find(r => r.offsetTop + r.offsetHeight > viewport.scrollTop);
    anchor.current = first ? {key: first.dataset.rowKey!, top: first.offsetTop} : null;
  });

  return <div
    ref={contentRefs}
    data-slot="conversation-content"
    className={cn('flex h-max min-h-full flex-col justify-end gap-4', className)}
    style={{...style, ...(floor ? {minHeight: floor} : null)}}
    {...props}
  >{children}</div>;
}

type ItemProps = React.ComponentProps<'div'> & {
  /** A stable key for the prepend anchor. */
  rowKey?: string;
  /** Always laid out, even offscreen: the last user row and the last row. */
  pinned?: boolean;
};

function ConversationItem({className, rowKey, pinned, ...props}: ItemProps) {
  return <div
    data-slot="conversation-item"
    data-row-key={rowKey}
    data-pinned={pinned || undefined}
    className={cn('min-w-0 shrink-0', !pinned && '[contain-intrinsic-size:auto_160px] [content-visibility:auto]' /* value-ok: a height the browser assumes for an off-screen message until it lays one out, never drawn */, className)}
    {...props}
  />;
}

/** The reserved box at the end of the thread: the loader, then the turn's actions, in one height. */
function ConversationTail({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="conversation-tail" className={cn('flex min-h-(--control) min-w-0 shrink-0 items-center', className)} {...props}/>;
}

/** Scrolls the thread so `el` sits a quarter of the way down the viewport, after letting go of the end. */
function scrollToItem(viewport: HTMLElement, el: HTMLElement, detach: () => void) {
  detach();
  const top = el.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop - viewport.clientHeight / 4;
  viewport.scrollTo({top: Math.max(0, top), behavior: reducedMotion() ? 'auto' : 'smooth'});
}

/** The items in the thread marked data-waiting: a call waiting on the person. */
const marked = (content: HTMLElement) => [...content.querySelectorAll<HTMLElement>('[data-waiting]')];

type ConversationJumpLabels = {
  /** The button's words near nothing waiting. */
  latest?: string;
  /** The button's words while a call waits on the person out of view. */
  waitingOnYou?: string;
};

const jumpLabels: Required<ConversationJumpLabels> = {latest: 'Latest', waitingOnYou: statusLabels.waiting};

/**
 * Floats over the thread's end corner once it is more than max(400px, the viewport's height) from the end, and reads
 * "Latest". While a call waits on the person out of view, it reads "Waiting on you" with the count in an ink cell and
 * takes them to the first waiting call, focusing its first action. It goes inert as it hides, so when it had focus (it
 * was pressed) focus moves to the thread rather than falling to the body.
 */
function ConversationJump({className, children, onClick, waiting: watchWaiting = true, labels, ref, ...props}: Omit<React.ComponentProps<typeof Button>, 'onClick'> & {
  onClick?: () => void;
  /** Jump to a call waiting on the person when one is out of view. Set false to keep it to Latest. */
  waiting?: boolean;
  /** The button's words, for another language. */
  labels?: ConversationJumpLabels;
}) {
  const {distance, viewportRef, contentRef, scrollToEnd, detach} = useConversation();
  const words = withDefaults(jumpLabels, labels);
  const [waiting, setWaiting] = useState<{count: number; away: boolean}>({count: 0, away: false});
  // Re-reads the waiting calls as the view scrolls and as the content changes.
  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!watchWaiting || !viewport || !content) return;
    const read = () => {
      const calls = marked(content);
      const box = viewport.getBoundingClientRect();
      const away = calls.some(el => { const r = el.getBoundingClientRect(); return r.bottom < box.top || r.top > box.bottom; });
      setWaiting(prev => (prev.count === calls.length && prev.away === away ? prev : {count: calls.length, away}));
    };
    const frame = requestAnimationFrame(read);
    const mo = new MutationObserver(read);
    mo.observe(content, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-waiting']});
    viewport.addEventListener('scroll', read, {passive: true});
    return () => { cancelAnimationFrame(frame); mo.disconnect(); viewport.removeEventListener('scroll', read); };
  }, [watchWaiting, viewportRef, contentRef]);
  const toWaiting = watchWaiting && waiting.away;
  const far = distance > Math.max(400, viewportRef.current?.clientHeight ?? 0);
  const active = far || toWaiting;
  const button = useRef<HTMLButtonElement>(null);
  const buttonRefs = useMemo(() => mergeRefs(button, ref), [ref]);
  // Before paint, while the button still holds focus: the browser drops focus from an inert element at its next frame.
  useLayoutEffect(() => {
    if (!active && button.current && button.current === document.activeElement) viewportRef.current?.focus({preventScroll: true});
  }, [active, viewportRef]);
  const jump = () => {
    const viewport = viewportRef.current;
    const first = contentRef.current && marked(contentRef.current).at(0);
    if (toWaiting && viewport && first) {
      scrollToItem(viewport, first, detach);
      // Its first action (Deny, the safe one), else the row itself.
      (first.querySelector<HTMLElement>('[data-slot=tool-call-actions] button') ?? first.querySelector<HTMLElement>('button'))?.focus({preventScroll: true});
    } else scrollToEnd();
    onClick?.();
  };
  return <Button
    ref={buttonRefs}
    data-slot="conversation-jump"
    data-active={active}
    data-waiting={toWaiting || undefined}
    variant="secondary"
    size="sm"
    // inert, not aria-hidden: out of the tab order and the tree while near the end, still named.
    inert={!active || undefined}
    onClick={jump}
    className={mergeClass([
      // The float shadow sits on ::before, which a secondary key leaves free: a shadow on the button itself would replace
      // the key's edge. An outer shadow is not drawn under its own box, so it only shows around the button.
      'absolute end-5 bottom-4 z-(--z-raised) before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:shadow-overlay',
      'transition-opacity duration-(--dur-base) motion-reduce:transition-none',
      'data-[active=false]:pointer-events-none data-[active=false]:opacity-0',
    ], className)}
    {...props}
  >{children ?? (toWaiting
    ? <><Icon icon={waitingAbove(viewportRef.current, contentRef.current) ? ArrowUp : ArrowDown} size={16}/>{words.waitingOnYou}<InkSlot size="sm" aria-hidden>{waiting.count}</InkSlot><span className="sr-only">, {waiting.count}</span></>
    : <><Icon icon={ArrowDown} size={16}/>{words.latest}</>)}</Button>;
}

/** The first waiting call sits above the view, so the jump points up. */
function waitingAbove(viewport: HTMLElement | null, content: HTMLElement | null) {
  const first = content && marked(content).at(0);
  return !!viewport && !!first && first.getBoundingClientRect().bottom < viewport.getBoundingClientRect().top;
}

// ---------- Rows ----------

type ErrorKind = 'auth' | 'rate-limit' | 'quota' | 'server' | 'network' | 'gone';

type ConversationRow =
  /** The person's turn, a right-aligned bubble. `name` defaults to labels.you and is read aloud, not drawn; `meta` is the time. `avatar` is deprecated and is not drawn. */
  | {type: 'user'; id: string; text: string; meta?: string; name?: string; /** @deprecated Not drawn. */ avatar?: React.ReactNode}
  | {type: 'assistant'; id: string; content: React.ReactNode}
  /** The agent's turn the moment the person sends: a running "Thinking" and no body yet. The author is read aloud, not drawn. */
  | {type: 'thinking'; id: string; label?: string; author?: string}
  | {type: 'retry'; id: string; attempt: number; next: number; message?: string}
  | {type: 'diff'; id: string; files: number; additions: number; deletions: number}
  | {type: 'error'; id: string; kind: ErrorKind; message?: string}
  | {type: 'divider'; id: string; reason: 'compaction' | 'interrupted'; label?: string};

/** The rows' words, for another language. ConversationTimeline passes them to its retry and error rows. */
type ConversationLabels = {
  /** The retry row: the countdown, the moment it retries, the attempt, and its button. */
  retryingIn?: (seconds: number) => string;
  retryingNow?: string;
  attempt?: (attempt: number) => string;
  retryNow?: string;
  /** The error row's title for each kind, and its button. */
  errors?: Partial<Record<ErrorKind, string>>;
  retry?: string;
  /** The thinking row's label when the row has none. */
  thinking?: string;
  /** The person's name on a user row that has none. */
  you?: string;
  /** The agent's name on a thinking row that has no author. */
  agent?: string;
  /** The diff summary: the files line, then what is read after each count. */
  filesChanged?: (files: number) => string;
  added?: string;
  removed?: string;
};

const conversationLabels = {
  retryingIn: (seconds: number) => `Retrying in ${seconds}s`,
  retryingNow: 'Retrying now',
  attempt: (attempt: number) => `attempt ${attempt}`,
  retryNow: 'Retry now',
  errors: {
    auth: 'Sign in again to continue',
    'rate-limit': 'Rate limited by the model provider',
    quota: 'Out of credits for this workspace',
    server: 'The model provider failed',
    network: 'Lost the connection',
    gone: 'This run no longer exists',
  } as Record<ErrorKind, string>,
  retry: 'Retry',
  thinking: 'Thinking',
  you: 'You',
  agent: 'Agent',
  filesChanged: (files: number) => `${files} ${files === 1 ? 'file' : 'files'} changed`,
  added: 'added',
  removed: 'removed',
};

const conversationWords = (labels?: ConversationLabels) => ({...withDefaults(conversationLabels, labels), errors: withDefaults(conversationLabels.errors, labels?.errors)});

/** Seconds until `next`, ticking each second, never below 0. */
function useCountdown(next: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [next]);
  return now === null ? null : Math.max(0, Math.ceil((next - now) / 1000));
}

/** "Retrying in 4s" beside "attempt 2". A message over 80 characters is cut, with the full text on hover. */
function ConversationRetry({attempt, next, message, onRetry, labels, className, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {attempt: number; next: number; message?: string; onRetry?: () => void; labels?: ConversationLabels}) {
  const words = conversationWords(labels);
  const left = useCountdown(next);
  const short = message && message.length > 80 ? `${message.slice(0, 79)}…` : message;
  return <div data-slot="conversation-retry" className={cn('flex min-h-(--row-sm) min-w-0 flex-wrap items-center gap-x-3 ps-4 pe-1.5 rule-row', className)} {...props}>
    <Status status="running">{left ? words.retryingIn(left) : words.retryingNow}</Status>
    <span className="type-body-sm text-text-3 data">{words.attempt(attempt)}</span>
    {short && <span title={message} className="min-w-0 grow basis-48 truncate [contain:inline-size] type-body-sm text-text-2">{short}</span>}
    {onRetry && <Button variant="ghost" size="sm" onClick={onRetry} className="ms-auto">{words.retryNow}</Button>}
  </div>;
}

/** A typed error at the end of the turn, as a failing row: the fail wash and the word. The partial answer above it stays. */
function ConversationError({kind, message, onRetry, labels, className, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {kind: ErrorKind; message?: string; onRetry?: () => void; labels?: ConversationLabels}) {
  const words = conversationWords(labels);
  return <div data-slot="conversation-error" data-status="fail" data-error={kind} className={cn('relative flex min-h-(--row) min-w-0 flex-wrap items-center gap-x-3 gap-y-1 bg-accent-wash py-1.5 ps-4 pe-1.5', className)} {...props}>
    <Status status="fail">{words.errors[kind]}</Status>
    {message && <span className="min-w-0 grow basis-48 type-body-sm text-text-2 [overflow-wrap:anywhere] [contain:inline-size]">{message}</span>}
    {onRetry && kind !== 'gone' && <Button variant="secondary" size="sm" onClick={onRetry} className="ms-auto">{words.retry}</Button>}
  </div>;
}

function rowEqual(a: ConversationRow, b: ConversationRow) {
  if (a === b) return true;
  if (a.type !== b.type || a.id !== b.id) return false;
  const ka = Object.keys(a) as (keyof ConversationRow)[];
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
}

/** Reuses the previous row object when a row is structurally equal, and the previous array when all are. */
function useStableRows(rows: readonly ConversationRow[]) {
  const prev = useRef<readonly ConversationRow[]>(rows);
  const byId = new Map(prev.current.map(r => [r.id, r]));
  let same = rows.length === prev.current.length;
  const next = rows.map((row, i) => {
    const old = byId.get(row.id);
    const keep = old && rowEqual(old, row) ? old : row;
    if (keep !== prev.current[i]) same = false;
    return keep;
  });
  const out = same ? prev.current : next;
  useEffect(() => { prev.current = out; });
  return out;
}

const Row = memo(function Row({row, onRetry, labels}: {row: ConversationRow; onRetry?: (row: ConversationRow) => void; labels?: ConversationLabels}) {
  const words = conversationWords(labels);
  switch (row.type) {
    case 'user': {
      const name = row.name ?? words.you;
      return <Message from="user">
        <MessageContent>
          <MessageHeader>{name}{row.meta && <MessageTime>{row.meta}</MessageTime>}</MessageHeader>
          <MessageBubble><MessageBubbleContent>{row.text}</MessageBubbleContent></MessageBubble>
        </MessageContent>
      </Message>;
    }
    case 'assistant': return <>{row.content}</>;
    case 'thinking': return <AgentTurn name={row.author ?? words.agent} state="live">
      <Status status="running" className="text-text-2">{row.label ?? words.thinking}</Status>
    </AgentTurn>;
    case 'retry': return <ConversationRetry attempt={row.attempt} next={row.next} message={row.message} labels={labels}/>;
    case 'diff': return <p data-slot="conversation-diff" className="relative flex min-h-(--row-sm) items-center gap-2 px-4 type-body-sm text-text-2 data">
      <span className="text-text-1">{words.filesChanged(row.files)}</span>
      <DiffCount added={row.additions} removed={row.deletions} addedLabel={words.added} removedLabel={words.removed}/>
    </p>;
    case 'error': return <ConversationError kind={row.kind} message={row.message} onRetry={onRetry ? () => onRetry(row) : undefined} labels={labels}/>;
    case 'divider': return <MessageDivider reason={row.reason}>{row.label}</MessageDivider>;
  }
});

type ConversationTimelineProps = {
  rows: readonly ConversationRow[];
  /** Replaces the default renderer for a row type. Return undefined to fall back. */
  renderRow?: (row: ConversationRow) => React.ReactNode | undefined;
  onRetry?: (row: ConversationRow) => void;
  /** The rows' words, for another language. Keep the object stable: a new one re-renders every row. */
  labels?: ConversationLabels;
};

/**
 * Renders typed rows. Thinking shows only while the thread streams and only as the last row; a diff
 * summary waits for idle; the last user row and the last row are always laid out.
 */
function ConversationTimeline({rows, renderRow, onRetry, labels}: ConversationTimelineProps) {
  const {status} = useConversation();
  const stable = useStableRows(rows);
  const lastUser = stable.findLastIndex(r => r.type === 'user');
  const visible = stable.filter((r, i) => (r.type === 'thinking' ? status === 'streaming' && i === stable.length - 1 : r.type === 'diff' ? status !== 'streaming' : true));
  return <>{visible.map((row, i) => <ConversationItem key={row.id} rowKey={row.id} pinned={i === visible.length - 1 || row === stable[lastUser]} data-row-type={row.type}>
    {renderRow?.(row) ?? <Row row={row} onRetry={onRetry} labels={labels}/>}
  </ConversationItem>)}</>;
}

export {
  Conversation, ConversationProvider, ConversationViewport, ConversationContent, ConversationItem, ConversationTail,
  ConversationJump, ConversationTimeline, ConversationRetry, ConversationError,
  useConversation, useStickToBottom, useStableRows, useCountdown, STICK, REATTACH,
  type ConversationProps, type ConversationLabels, type ConversationJumpLabels, type ConversationViewportLabels, type ConversationRow, type ConversationStatus, type ErrorKind,
};
