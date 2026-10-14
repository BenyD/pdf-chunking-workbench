'use client';

import {createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useMemo, type ReactNode} from 'react';
import {cva} from 'class-variance-authority';
import {cn, mergeRefs} from '@/lib/quartz/utils';
import {Button, ButtonSize} from '@/components/quartz/ui/button';
import {Icon, Information, WarningAlt, Close, CloseOutline, type QuartzIcon} from '@/components/quartz/icon';

// A message about the view it sits in. One component for three old ones: the inline alert, the
// page-wide banner (placement="page") and the docs note (size="sm" with a lead-in title).
//
// Status says how bad it is. An inline alert is a frame: paper, one grey edge, the 10px frame corner. warn and fail are
// marked where they are, not painted across: the icon and the title in the status text colour, the title naming
// the trouble. No wash anywhere. A page alert is a band under the top bar with a grey line below it. inverse is deprecated (an ink band is a header in
// ink) and renders as neutral. An alert never takes a kind's hue. Ink carries every word.
//
// Its considered detail is how it leaves. warn and fail never take a close button: they stay until the
// problem is gone. A neutral alert with a dismissKey stays dismissed for that key, so the same notice
// does not come back on every visit, and comes back by itself when the key changes with the message.
// Dismissing moves focus to the next focusable thing after the alert, never to the top of the page.

type AlertStatus = 'neutral' | 'warn' | 'fail';
/** @deprecated Use AlertStatus. 'inverse' renders as neutral. */
type AlertTone = AlertStatus | 'inverse';
type AlertPlacement = 'inline' | 'page';

// Three silhouettes that differ without color: a circle with i, a triangle, a circle with x.
const statusIcon: Record<AlertStatus, QuartzIcon> = {neutral: Information, warn: WarningAlt, fail: CloseOutline};

const alertVariants = cva('group/alert @container/alert relative w-full min-w-0 bg-page text-start text-text-1', {
  variants: {
    placement: {
      inline: 'frame px-4 py-3',
      page: 'flex flex-col justify-center px-4 py-2 min-h-(--control-lg) sm:px-6 shadow-[inset_0_-1px_0_var(--line-frame)]',
    },
    size: {
      default: '',
      sm: '',
    },
    // A page alert inside a padded region: its own frame, no line under it.
    inset: {true: 'frame shadow-none', false: ''},
  },
  compoundVariants: [
    {placement: 'inline', size: 'sm', className: 'px-4 py-2'},
    {placement: 'page', size: 'sm', className: 'min-h-(--control) py-1.5'},
  ],
  defaultVariants: {placement: 'inline', size: 'default', inset: false},
});

let warnedInverse = false;

type AlertContextValue = {status: AlertStatus; dismiss: () => void; dismissible: boolean};
const AlertContext = createContext<AlertContextValue | null>(null);

const storageKey = (key: string) => `quartz:alert-dismissed:${key}`;

function readDismissed(key: string) {
  try { return localStorage.getItem(storageKey(key)) === '1'; } catch { return false; }
}

/** The next element after `from` in document order that takes focus, outside `from` itself. */
function nextFocusable(from: HTMLElement) {
  const all = [...document.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')];
  return all.find(el => !from.contains(el) && (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
}

type AlertProps = Omit<React.ComponentProps<'div'>, 'title'> & {
  /** How bad it is. warn and fail take the status text colour on the icon and title, and never a close button. */
  status?: AlertStatus;
  /** @deprecated Use status. 'inverse' is gone and renders as neutral. */
  tone?: AlertTone;
  /** inline: in the flow of a page or panel. page: a full-width strip at the top of a page or app shell. */
  placement?: AlertPlacement;
  size?: 'default' | 'sm';
  /** A page alert with rounded corners, for one that sits inside a padded region. */
  inset?: boolean;
  /**
   * The lead icon. true shows the status's (Information, WarningAlt, CloseOutline); false hides it; an element replaces it,
   * as in icon={<Icon icon={Megaphone} size={16}/>}. Defaults to true inline, and page-wide to true for warn
   * and fail (so a page warn and fail never differ by hue alone) and false otherwise.
   */
  icon?: boolean | ReactNode;
  /** false for a static note that is part of the page and must not be announced. Defaults to on. */
  announce?: boolean;
  /** Remembers a dismissal under this key (localStorage). Change the key when the message changes. */
  dismissKey?: string;
  onDismiss?: () => void;
  /** @deprecated Use status. The v1 name for it; 'default' maps to neutral. */
  variant?: 'default' | 'warn' | 'fail';
};

function Alert({className, status: statusProp, tone: toneProp, placement = 'inline', size = 'default', inset = false, icon, announce = true, dismissKey, onDismiss, variant, role, children, ref, ...props}: AlertProps) {
  const asked: AlertTone = statusProp ?? toneProp ?? (variant === 'warn' || variant === 'fail' ? variant : 'neutral');
  if (asked === 'inverse' && !warnedInverse && process.env.NODE_ENV !== 'production') {
    warnedInverse = true;
    console.warn('Alert tone="inverse" is deprecated: an ink band is a header in ink. It renders as neutral.');
  }
  const level: AlertStatus = asked === 'inverse' ? 'neutral' : asked;
  const root = useRef<HTMLDivElement>(null);
  const rootRefs = useMemo(() => mergeRefs(root, ref), [ref]);
  // Undefined until the stored dismissal is read, so an alert dismissed before never flashes in.
  const [dismissed, setDismissed] = useState<boolean | undefined>(dismissKey ? undefined : false);

  useLayoutEffect(() => {
    if (dismissKey) setDismissed(readDismissed(dismissKey));
  }, [dismissKey]);

  const dismissible = level === 'neutral';
  const dismiss = useCallback(() => {
    if (!dismissible) return;
    const next = root.current ? nextFocusable(root.current) : null;
    if (dismissKey) { try { localStorage.setItem(storageKey(dismissKey), '1'); } catch {} }
    setDismissed(true);
    onDismiss?.();
    requestAnimationFrame(() => next?.focus());
  }, [dismissible, dismissKey, onDismiss]);

  if (dismissed !== false) return null;
  // Nothing to say, so no box and no icon.
  if (children === undefined || children === null || children === false) return null;

  const status = level === 'warn' || level === 'fail' ? level : undefined;
  const statusGlyph = statusIcon[level];
  const glyph: ReactNode = icon === false || icon === null ? null
    : icon !== true && icon !== undefined ? icon
    : (icon ?? (placement === 'inline' || !!status)) && statusGlyph ? <Icon icon={statusGlyph} size={16}/> : null;

  // Parts place themselves on named grid areas, so they work in any order and whether the children were
  // composed on the server or the client. The action moves under the message when the alert is narrow,
  // and under 12rem the close takes the first row by itself so it never sits over a word.
  return <AlertContext.Provider value={{status: level, dismiss, dismissible}}>
    <div
      ref={rootRefs}
      data-slot="alert"
      data-placement={placement}
      data-size={size}
      data-status={status}
      role={role ?? (announce ? (status ? 'alert' : 'status') : undefined)}
      className={cn(alertVariants({placement, size, inset: placement === 'page' && inset}), className)}
      {...props}
    >
      <div
        data-slot="alert-grid"
        className={cn(
          'grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] [grid-template-areas:"icon_title_action_close""icon_desc_action_close""icon_more_more_more"]',
          '@max-[12rem]/alert:[grid-template-areas:"icon_icon_icon_close""title_title_title_title""desc_desc_desc_desc""more_more_more_more"]',
          placement === 'page' ? 'items-center' : 'items-start',
        )}
      >
        {/* The icon's box is one line of the first text, the title's or the description's, so it centres on that line. */}
        {glyph && <span data-slot="alert-icon" className={cn('flex items-center [grid-area:icon] self-start text-text-2 group-data-[status=warn]/alert:text-warn-text group-data-[status=fail]/alert:text-fail-text', size === 'sm' ? 'me-2 h-lh type-body-sm' : 'me-3 h-lh type-label group-not-has-data-[slot=alert-title]/alert:type-body-sm')}>
          {glyph}
        </span>}
        {children}
      </div>
    </div>
  </AlertContext.Provider>;
}

function useAlert() {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error('Alert parts must be inside <Alert>.');
  return ctx;
}

/** The headline, over the description. */
function AlertTitle({className, ...props}: React.ComponentProps<'p'>) {
  return <p
    data-slot="alert-title"
    className={cn('min-w-0 pb-0.5 type-label leading-5! text-current [overflow-wrap:anywhere] [grid-area:title] group-data-[size=sm]/alert:type-body-sm', className)}
    {...props}
  />;
}

/** What happened and what to do now. A lead-in goes first in <strong>. Links inside are ink and underlined. */
function AlertDescription({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="alert-description"
    className={cn(
      'min-w-0 type-body-sm text-text-2 [overflow-wrap:anywhere] [grid-area:desc]',
      '[&_a]:text-current [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4 [&_strong]:font-medium [&_strong]:text-text-1',
      className,
    )}
    {...props}
  />;
}

/** One action, at the end of the row; under the message when the alert is narrower than 24rem. */
function AlertAction({className, children, ...props}: React.ComponentProps<'div'>) {
  // Buttons here are sm (28px), the close button's height, so the action and the close share one line.
  return <div
    data-slot="alert-action"
    className={cn(
      'ms-3 -my-1 flex max-w-full min-w-0 flex-wrap items-center gap-2 self-center [grid-area:action]',
      '@max-sm/alert:ms-0 @max-sm/alert:mt-2 @max-sm/alert:mb-0 @max-sm/alert:justify-self-start @max-sm/alert:[grid-area:more]',
      className,
    )}
    {...props}
  ><ButtonSize size="sm">{children}</ButtonSize></div>;
}

/**
 * Dismisses a neutral alert. Renders nothing on warn and fail, which stay until the problem
 * is fixed. With the Alert's dismissKey the dismissal is remembered.
 */
function AlertClose({className, label = 'Dismiss', onClick, ...props}: Omit<React.ComponentProps<'button'>, 'children'> & {label?: string}) {
  const {dismiss, dismissible} = useAlert();
  if (!dismissible) {
    if (process.env.NODE_ENV !== 'production') console.warn('AlertClose: warn and fail alerts stay until the problem is fixed, so the close button is not rendered.');
    return null;
  }
  return <Button
    variant="ghost"
    size="icon-sm"
    data-slot="alert-close"
    aria-label={label}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) dismiss(); }}
    className={cn(
      // Centred on the first line, whichever it is: the title's, or the description's when there is no title.
      '-my-[calc((var(--control-sm)-1lh)/2)] group-not-has-data-[slot=alert-title]/alert:type-body-sm ms-2 -me-1 self-start bg-transparent text-current [grid-area:close]',
      'group-data-[placement=page]/alert:my-0 group-data-[placement=page]/alert:self-center',
      'not-pointer-coarse:after:absolute not-pointer-coarse:after:-inset-1 not-pointer-coarse:after:content-[""]',
      // Under 12rem the close has the first row to itself; the icon, if any, starts that row.
      '@max-[12rem]/alert:mb-1',
      className,
    )}
    {...props}
  >
    <Icon icon={Close} size={16}/>
  </Button>;
}

export {Alert, AlertTitle, AlertDescription, AlertAction, AlertClose, alertVariants, type AlertProps, type AlertStatus, type AlertTone, type AlertPlacement};
