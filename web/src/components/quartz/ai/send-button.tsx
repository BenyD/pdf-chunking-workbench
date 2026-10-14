'use client';

import * as React from 'react';
import {Icon, ArrowUp} from '@/components/quartz/icon';
import {Button, type ButtonProps} from '@/components/quartz/ui/button';
import {cn, mergeClass, withDefaults} from '@/lib/quartz/utils';

// The composer's one action: send while the prompt is ready, stop while the agent works, in the same 28px
// box so the pointer never moves. The statuses are ready, submitted, streaming, stopping and error.
// - ready: an ink square with an up arrow, a person's hand. With nothing to send (`empty`) it is Button's disabled
//   primary, ink at 40% with no outline; the same look, focusable with a reason, while
//   something blocks the send (`blockedReason`, uploads).
// - submitted: the prompt is on its way and no byte has come back. It is already Stop.
// - streaming: Stop.
// - stopping: Stop was pressed. The box stays, presses are ignored, `aria-busy` is set.
// - error: the last send failed. The arrow returns, named "Send again", with a 2px fail ring outside the key.
//
// The considered detail: Stop works before the first byte. Most chat UIs disable the button while
// a request is in flight, so a slow or stuck request cannot be cancelled. Here `submitted` is the stop
// square, shown while the first byte is on its way, so "sending" and "streaming" both read as Stop. Stop is idempotent: the first press calls onStop once per
// `generation` and every later press, double click or held Enter is dropped, so a late cancel never
// fires twice and never cancels the next turn. onStop receives that generation, so the caller can settle
// the run it names and ignore a stop echo that lands after a newer run began.
//
// blockedReason is only a description. Sighted people need the same reason in visible text next to the
// button; inside PromptInput the status line carries it.

type SendStatus = 'ready' | 'submitted' | 'streaming' | 'stopping' | 'error';

type SendButtonProps = Omit<ButtonProps, 'children' | 'pending' | 'pendingLabel' | 'variant'> & {
  status?: SendStatus;
  /** Called once per generation when the person stops, with the generation it stops. */
  onStop?: (generation: string | number | undefined) => void;
  /** Nothing to send yet. Ignored while working, so stop always works. */
  empty?: boolean;
  /** Something blocks the send: "Waiting for 2 uploads". Disabled but focusable, and the reason is its description. */
  blockedReason?: string;
  /** The run this button stops. A new generation re-arms Stop; the same one never stops twice. */
  generation?: string | number;
  /** The button's name in each state, for another language. */
  labels?: SendButtonLabels;
};

type SendButtonLabels = {
  send?: string;
  stop?: string;
  stopping?: string;
  /** After a failed send. */
  sendAgain?: string;
};

const sendLabels: Required<SendButtonLabels> = {send: 'Send', stop: 'Stop', stopping: 'Stopping', sendAgain: 'Send again'};
const working = (status: SendStatus) => status === 'submitted' || status === 'streaming' || status === 'stopping';

function SendButton({status = 'ready', onStop, empty, blockedReason, generation, labels, disabled, onClick, size = 'icon-sm', className, type, ...props}: SendButtonProps) {
  const words = withDefaults(sendLabels, labels);
  const names: Record<SendStatus, string> = {ready: words.send, submitted: words.stop, streaming: words.stop, stopping: words.stopping, error: words.sendAgain};
  const reasonId = React.useId();
  // The generation that was stopped. A press for the same generation is dropped.
  const stopped = React.useRef<string | number | undefined | null>(null);
  const [stopPressed, setStopPressed] = React.useState(false);
  React.useEffect(() => {
    if (!working(status)) { stopped.current = null; setStopPressed(false); }
  }, [status]);
  React.useEffect(() => { stopped.current = null; setStopPressed(false); }, [generation]);

  const isWorking = working(status);
  const shown: SendStatus = isWorking && stopPressed ? 'stopping' : status;
  const blocked = !isWorking && !!blockedReason;
  const nothing = !isWorking && !!empty && !blocked;
  const stop = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (shown === 'stopping' || stopped.current === (generation ?? 'current')) return;
    stopped.current = generation ?? 'current';
    setStopPressed(true);
    onStop?.(generation);
  };

  return <>
    <Button
      data-slot="send-button"
      data-state={shown}
      data-empty={nothing || undefined}
      data-status={shown === 'error' ? 'fail' : undefined}
      type={isWorking ? 'button' : type ?? 'submit'}
      size={size}
      disabled={isWorking ? disabled : disabled || empty || blocked}
      focusableWhenDisabled={blocked || shown === 'stopping'}
      aria-busy={shown === 'stopping' || undefined}
      aria-label={names[shown]}
      aria-describedby={blocked ? reasonId : undefined}
      aria-keyshortcuts={isWorking ? 'Escape' : 'Enter'}
      onClick={isWorking ? stop : onClick}
      className={mergeClass([
        // The fail ring is an outline: the primary key already draws its edge with box-shadow, so a second shadow would replace it.
        // Keyboard focus takes the outline back, so the focus ring still shows.
        shown === 'error' && 'outline-2 outline-(--fail-mark) focus-visible:focus-ring',
        shown === 'stopping' && 'cursor-progress',
      ], className)}
      {...props}
    >
      {isWorking
        ? <>
            <span aria-hidden data-slot="send-button-stop" className={cn('size-2.5 rounded-[1px] bg-current forced-colors:bg-[CanvasText]', shown === 'stopping' && 'opacity-40')}/>{/* value-ok: the stop glyph's 1px corner is part of the icon drawing, not a container radius */}
          </>
        : <Icon icon={ArrowUp} size={16}/>}
    </Button>
    {blocked && <span id={reasonId} hidden>{blockedReason}</span>}
  </>;
}

export {SendButton, type SendButtonProps, type SendButtonLabels, type SendStatus};
