'use client';

import * as React from 'react';
import {Dialog as DialogPrimitive} from '@base-ui/react/dialog';
import {AlertDialog as AlertDialogPrimitive} from '@base-ui/react/alert-dialog';
import {cva, type VariantProps} from 'class-variance-authority';
import {Button, ButtonSize, type ButtonProps} from '@/components/quartz/ui/button';
import {fieldControlVariants} from '@/components/quartz/ui/field';
import {CodeTag} from '@/components/quartz/ui/badge';
import {Icon, Warning, Close as CloseIcon} from '@/components/quartz/icon';
import {cn, mergeClass, mergeRefs} from '@/lib/quartz/utils';
import {useQuartzModal, useQuartzPortal} from '@/lib/quartz/portal';
import {backdropClass, closesAfter, overlayShellSurface, useDefaultAction, useOverlayOpen, type DefaultAction} from '@/lib/quartz/overlay';

// Quartz's dialog, on Base UI's Dialog and AlertDialog. One component, three jobs:
//
//   <Dialog>                                   modal work: a form, a preview, a choice
//   <Dialog role="alertdialog">                one question; no outside-click dismiss, no corner X
//   <Dialog role="alertdialog" confirmText=…>  an irreversible action the person confirms by typing a name
//
// The footer declares what Enter does (`defaultAction`). A destructive action makes dismiss the
// default. DialogAction takes `onAction`: a returned promise turns the button
// pending, blocks every way out (Escape, the backdrop, Cancel, the X) until it settles, closes on
// success and shows the error inside the dialog on failure. An action with nothing to run closes the
// dialog, as a plain confirm button does. The typed-confirm field lights the name character by
// character and marks the first one that differs. While a modal dialog is open the page behind is inert
// (useQuartzModal), so Tab and a screen reader stay inside. A tall dialog scrolls between a sticky header
// and footer, with the X pinned to its corner. The dialog is a shell: the panel grey (--surface-frame) holding one
// white bordered card 4px in from its edge. The header (a 16px heading, the description 6px under it, the X in its
// corner) is the top of that card and the body (DialogBody) its rest, with no line between them; the actions sit back
// on the grey at an 8px inset. A dialog with only a question is the header alone as the card, then the actions.
// When the action failed, or when the primary action is destructive, the title names the trouble. Focus returns to the trigger on close, and Escape closes
// only the innermost overlay (Base UI).

// ---------- Root state: role, pending, error, typed confirm ----------

type DialogRole = 'dialog' | 'alertdialog';

type DialogState = {
  role: DialogRole;
  /** The name the person must type before the primary action enables. */
  confirmText?: string;
  typed: string;
  setTyped: (value: string) => void;
  matched: boolean;
  pending: boolean;
  error: string | null;
  run: (action: () => void | Promise<unknown>, closeAfter: boolean) => void;
  close: () => void;
  /** Open and modal (modal={true}): the page behind is inert. */
  locks: boolean;
};

const DialogContext = React.createContext<DialogState | null>(null);

/** The nearest dialog's state: role, pending, error and the typed confirm. */
function useDialog() {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error('Dialog parts must be inside <Dialog>.');
  return context;
}

type DialogProps = Omit<DialogPrimitive.Root.Props, 'role'> & {
  /**
   * dialog: modal work, dismissed by Escape, the backdrop or the X. alertdialog: one question the
   * person must answer; the backdrop does nothing and there is no X, Escape still backs out.
   */
  role?: DialogRole;
  /**
   * The exact name the person types to confirm, case-sensitive. The primary DialogAction stays
   * disabled until it matches. Pair it with role="alertdialog" and a destructive action.
   */
  confirmText?: string;
};

function Dialog({role = 'dialog', confirmText, open: openProp, defaultOpen = false, onOpenChange, modal = true, children, ...props}: DialogProps) {
  const {open, setOpen, pending, error, session, run} = useOverlayOpen<DialogPrimitive.Root.ChangeEventDetails>({
    open: openProp, defaultOpen, onOpenChange,
  });
  // The typed confirm belongs to one open: a new session, however the dialog opened, starts it empty.
  const [entry, setEntry] = React.useState({session, value: ''});
  const typed = entry.session === session ? entry.value : '';
  const setTyped = React.useCallback((value: string) => setEntry({session, value}), [session]);

  const matched = confirmText === undefined || typed.trim() === confirmText;
  // An alert dialog is always modal in Base UI.
  const locks = open && (role === 'alertdialog' || modal === true);

  const state = React.useMemo<DialogState>(() => ({
    role, confirmText, typed, setTyped, matched, pending, error, run, close: () => setOpen(false), locks,
  }), [role, confirmText, typed, setTyped, matched, pending, error, run, setOpen, locks]);

  return <DialogContext.Provider value={state}>
    {role === 'alertdialog'
      ? <AlertDialogPrimitive.Root data-slot="dialog" open={open} onOpenChange={setOpen} {...(props as AlertDialogPrimitive.Root.Props)}>{children}</AlertDialogPrimitive.Root>
      : <DialogPrimitive.Root data-slot="dialog" open={open} onOpenChange={setOpen} modal={modal} {...props}>{children}</DialogPrimitive.Root>}
  </DialogContext.Provider>;
}

// ---------- Shared looks ----------

/** The overlay shell from lib/overlay: the panel grey, the 10px frame corner, the frame ring and one short shadow. */
const dialogSurface = overlayShellSurface;

const dialogVariants = cva(
  [
    'group/dialog fixed top-1/2 left-1/2 z-(--z-overlay) flex max-h-[calc(100dvh-var(--space-8)*2)] w-[calc(100%-var(--gutter-sm)*2)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-y-auto overscroll-contain outline-none',
    dialogSurface,
    // Appears, never grows: opacity over --dur-slow on the step curve, out a step faster.
    'transition-opacity duration-(--dur-slow) ease-(--ease-step) data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:duration-(--dur-base)',
    // A nested dialog dims its parent rather than stacking a second backdrop.
    'after:pointer-events-none after:absolute after:inset-0 after:z-(--z-cover) after:rounded-[inherit] after:bg-overlay after:opacity-0 after:transition-opacity after:duration-(--dur-base) data-nested-dialog-open:after:opacity-100',
  ],
  {
    variants: {
      size: {
        sm: 'max-w-overlay-sm',
        default: 'max-w-overlay',
        lg: 'max-w-overlay-lg',
      },
    },
    defaultVariants: {size: 'default'},
  },
);

// ---------- Parts ----------

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props}/>;
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  const container = useQuartzPortal();
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={container} {...props}/>;
}

function DialogOverlay({className, ...props}: DialogPrimitive.Backdrop.Props) {
  return <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={mergeClass(backdropClass, className)} {...props}/>;
}

type DialogContentProps = DialogPrimitive.Popup.Props & VariantProps<typeof dialogVariants> & {
  /** The 28px ghost close button in the top corner. On for role="dialog", off for alertdialog. */
  showCloseButton?: boolean;
};

function DialogContent({className, size, showCloseButton, children, ref, onKeyDown, initialFocus, ...props}: DialogContentProps) {
  const {role, pending, locks} = useDialog();
  const withClose = showCloseButton ?? role === 'dialog';
  const action = useDefaultAction<HTMLDivElement>({ref, onKeyDown, initialFocus});
  useQuartzModal(locks);
  return <DialogPortal>
    <DialogOverlay/>
    <DialogPrimitive.Popup
      data-slot="dialog-content"
      data-size={size ?? 'default'}
      data-role={role}
      data-close={withClose || undefined}
      aria-busy={pending || undefined}
      className={mergeClass(dialogVariants({size}), className)}
      {...action}
      {...props}
    >
      {children}
      {/* Last in the tab order, first in layout: a zero-height sticky strip keeps the X in the corner
          while a tall dialog scrolls. */}
      {withClose && <div data-slot="dialog-close-anchor" className="pointer-events-none sticky top-0 z-(--z-above) order-first h-0">
        <DialogPrimitive.Close
          data-slot="dialog-close-button"
          aria-label="Close"
          disabled={pending}
          render={<Button variant="ghost" size="icon-sm" className="pointer-events-auto absolute end-4 top-5"/>}
        >
          <Icon icon={CloseIcon} size={16}/>
        </DialogPrimitive.Close>
      </div>}
    </DialogPrimitive.Popup>
  </DialogPortal>;
}

function DialogHeader({className, ...props}: React.ComponentProps<'div'>) {
  const {pending, error} = useDialog();
  return <div
    data-slot="dialog-header"
    data-pending={pending || undefined}
    data-status={error ? 'fail' : undefined}
    className={cn(
      // A dialog is a reading surface, so its card gets 20px in on every side (rows and panels keep 16). The heading sits
      // over its description 6px apart; the X sits on the heading's line.
      'grid grid-cols-1 gap-1.5 pt-5 pb-5 group-data-close/dialog:pe-14 group-has-data-[slot=dialog-body]/dialog:pb-0',
      // The top of the dialog's one white card, 4px in from the shell; with a body under it the card goes on with no line
      // between. Sticky: a tall dialog scrolls under the header, so the title and the X in its corner stay in view.
      'frame sticky top-1 z-(--z-raised) mx-1 mt-1 bg-page px-5 [--frame-radius:calc(var(--radius-frame)-4px)]',
      'group-has-data-[slot=dialog-body]/dialog:before:border-b-0 group-has-data-[slot=dialog-body]/dialog:[--frame-radius:calc(var(--radius-frame)-4px)_calc(var(--radius-frame)-4px)_0_0]',
      // A failed action, or a destructive question before anything has run: the header's accent mark takes the fail step.
      'group-has-[[data-dialog-action=primary][data-variant=destructive]]/dialog:[--accent-mark:var(--fail-mark)]',
      className,
    )}
    {...props}
  />;
}

/**
 * The dialog's body: the form, the preview, the typed confirm. The rest of the white card the header starts, with no line
 * between them, its bottom corners the frame's minus the 4px gap. Skip it for a dialog that is only a question and its answers.
 */
function DialogBody({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="dialog-body"
    className={cn(
      'frame mx-1 mb-1 flex min-w-0 flex-col gap-4 bg-page p-5 pt-6 before:border-t-0 [--frame-radius:0_0_calc(var(--radius-frame)-4px)_calc(var(--radius-frame)-4px)] group-has-data-[slot=dialog-footer]/dialog:mb-0',
      className,
    )}
    {...props}
  />;
}

type DialogFooterProps = React.ComponentProps<'div'> & {
  /**
   * What Enter does when focus is not on a control. primary presses the DialogAction; dismiss presses
   * the DialogClose; none leaves Enter alone. Unset, it is dismiss when the action is destructive and
   * primary otherwise.
   */
  defaultAction?: DefaultAction;
};

function DialogFooter({className, defaultAction, ref, children, ...props}: DialogFooterProps) {
  const {error} = useDialog();
  const footer = React.useRef<HTMLDivElement>(null);
  const setRef = React.useMemo(() => mergeRefs(footer, ref), [ref]);
  return <>
    {error && <div data-slot="dialog-error" role="alert" data-status="fail" className="flex items-start gap-2 bg-accent-wash px-5 py-2 type-body-sm text-text-1">
      <Icon icon={Warning} size={16} className="mt-0.5"/>
      <span className="min-w-0 break-words">{error}</span>
    </div>}
    <div
      ref={setRef}
      data-slot="dialog-footer"
      data-default-action={defaultAction ?? 'auto'}
      className={cn(
        'frame-foot flex-wrap justify-end',
        // Sticky: the actions stay reachable while a tall dialog scrolls. On the shell's grey, sm (28px) buttons 8px from every edge, as in Panel's footer.
        'sticky bottom-0 z-(--z-raised) bg-(--surface-frame)',
        className,
      )}
      {...props}
    ><ButtonSize size="sm">{children}</ButtonSize></div>
  </>;
}

function DialogTitle({className, ...props}: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={mergeClass('type-heading-xs text-text-1 break-words', className)} {...props}/>;
}

function DialogDescription({className, ...props}: DialogPrimitive.Description.Props) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={mergeClass('type-body text-text-2 break-words [&_a]:underline [&_a]:underline-offset-4', className)} {...props}/>;
}

/** Closes the dialog. In a footer it is the dismiss action. Disabled while an action runs. */
function DialogClose({disabled, ...props}: DialogPrimitive.Close.Props) {
  const {pending} = useDialog();
  return <DialogPrimitive.Close data-slot="dialog-close" data-dialog-action="dismiss" disabled={disabled || pending} {...props}/>;
}

type DialogActionProps = ButtonProps & {
  /**
   * Close the dialog after the action finishes. On with onAction, and on for a bare action with no
   * onAction, onClick or type="submit" (a "done"). Off when onClick or a form submit owns what happens.
   */
  close?: boolean;
  /**
   * Runs the action. A returned promise turns the button pending and holds the dialog open until it
   * settles: it closes on resolve and shows the rejection's message inside the dialog.
   */
  onAction?: () => void | Promise<unknown>;
};

/**
 * The footer's primary action: a Button that Enter presses when the footer's default is primary.
 * With `confirmText` on the Dialog it stays disabled until the typed name matches.
 */
function DialogAction({close, onAction, onClick, disabled, pending: pendingProp, ...props}: DialogActionProps) {
  const {matched, pending, run} = useDialog();
  const closeAfter = closesAfter({close, onAction, onClick, type: props.type});
  return <Button
    data-slot="dialog-action"
    data-dialog-action="primary"
    disabled={disabled || !matched}
    // The dialog's pending is the action's: whatever ran through useDialog().run spins here. A boolean
    // from the start (onAction or a pendingLabel) makes Button reserve the spinner's room.
    pending={pendingProp ?? (onAction !== undefined || props.pendingLabel !== undefined || pending ? pending : undefined)}
    onClick={event => {
      onClick?.(event);
      if (event.defaultPrevented) return;
      if (onAction || closeAfter) run(onAction ?? (() => {}), closeAfter);
    }}
    {...props}
  />;
}

type DialogConfirmFieldProps = Omit<React.ComponentProps<'input'>, 'value' | 'onChange' | 'children'> & {
  /** The words around the name. Defaults to "Type <name> to confirm". */
  label?: (name: React.ReactNode) => React.ReactNode;
};

/**
 * The typed confirm: the name to type, lit character by character as the person types it, with the
 * first character that differs marked. The Dialog's confirmText is the name.
 */
function DialogConfirmField({label = name => <>Type {name} to confirm</>, className, id, ...props}: DialogConfirmFieldProps) {
  const {confirmText, typed, setTyped, pending} = useDialog();
  const autoId = React.useId();
  const fieldId = id ?? autoId;
  const hintId = `${fieldId}-hint`;
  if (confirmText === undefined) return null;
  const value = typed.trim();
  let differs = -1;
  for (let i = 0; i < value.length; i++) if (value[i] !== confirmText[i]) { differs = i; break; }
  if (differs < 0 && value.length > confirmText.length) differs = confirmText.length;
  const good = differs < 0 ? value.length : differs;
  const name = <CodeTag fill="outline" data-slot="dialog-confirm-name" className="h-auto min-h-5 whitespace-normal break-all select-all">
    {Array.from(confirmText).map((ch, i) => <span
      key={i}
      data-char={i < good ? 'match' : i === differs ? 'differs' : 'rest'}
      data-status={i === differs ? 'fail' : undefined}
      className="text-text-3 data-[char=match]:text-text-1 data-[char=differs]:bg-accent-wash data-[char=differs]:text-text-1 data-[char=differs]:underline data-[char=differs]:decoration-accent-line data-[char=differs]:decoration-2 data-[char=differs]:underline-offset-2"
    >{ch}</span>)}
  </CodeTag>;
  const matchedNow = differs < 0 && value.length === confirmText.length;
  const hint = differs >= 0
    ? `Differs at character ${differs + 1}. The name is case-sensitive.`
    : value.length === confirmText.length ? 'Matches. Press the button to confirm; Enter does not.' : 'The name is case-sensitive. Enter does not confirm.';
  return <div data-slot="dialog-confirm-field" className="flex flex-col gap-2">
    <label htmlFor={fieldId} className="type-body text-text-2 break-words">{label(name)}</label>
    <input
      id={fieldId}
      data-autofocus
      value={typed}
      onChange={event => setTyped(event.target.value)}
      readOnly={pending}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      aria-describedby={hintId}
      aria-invalid={differs >= 0 || undefined}
      className={cn(
        fieldControlVariants(),
        'type-code pointer-coarse:type-code-touch read-only:text-text-2',
        // The typed name matches: the edge goes ink, the person's hand done.
        matchedNow && '[--frame-color:var(--line-control-hover)]',
        className,
      )}
      {...props}
    />
    {/* The hint is the field's description, read on focus. Only the match is announced, so a screen
        reader does not hear a new hint on every keystroke. */}
    <p id={hintId} className="type-body-sm text-text-3">{hint}</p>
    <p aria-live="polite" className="sr-only">{matchedNow ? 'Matches.' : ''}</p>
  </div>;
}

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogAction,
  DialogConfirmField,
  dialogVariants,
  dialogSurface,
  useDialog,
  type DialogProps,
  type DialogRole,
};
