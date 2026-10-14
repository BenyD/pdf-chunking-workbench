'use client';

import * as React from 'react';
import {Icon, Checkmark, Copy, Warning} from '@/components/quartz/icon';
import {cn} from '@/lib/quartz/utils';
import {Button, type ButtonProps} from '@/components/quartz/ui/button';

// Quartz's copy button: copies a value and confirms in place. The icon cuts from Copy to Check for
// 1.6s (no tween, Quartz swaps state as a cut), and a visually hidden status region says "Copied" so
// screen readers hear it too. With a visible label, "Copy" and "Copied" share one grid cell, so the box
// never changes width. If the clipboard is refused, it shows a warning glyph (in ink; the
// shape carries the meaning) and says so instead. A value fetched on demand (a function returning a
// promise, such as a secret read from the vault) pends in place with Button's spinner until it arrives,
// and a second press while it fetches does nothing.
//
// WebKit drops the press's user activation across an await, so awaiting the value and then calling
// writeText would fail there. For a fetched value the button calls clipboard.write in the same tick as
// the press, with a ClipboardItem whose text/plain is a promise of the blob; the browser holds the
// activation until the promise settles. Where that is missing or refused, it awaits the value and falls
// back to writeText. Not yet checked on a WebKit device.
//
// A second copy inside the confirmation clears the status region for a frame before filling it again,
// so a screen reader announces the repeat.

type CopyState = 'idle' | 'fetching' | 'copied' | 'failed';

/** Write a value that is still being fetched, keeping the press's user activation (WebKit). */
async function writeFetched(result: Promise<string>): Promise<string> {
  let text = '';
  const blob = result.then(t => { text = t; return new Blob([t], {type: 'text/plain'}); });
  const canWrite = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
  if (canWrite) {
    try {
      // Called before any await, so it runs inside the press.
      await navigator.clipboard.write([new ClipboardItem({'text/plain': blob})]);
      return text;
    } catch {
      // Fall through to writeText, which works wherever activation survives the await (Chromium).
    }
  }
  text = await result;
  await navigator.clipboard.writeText(text);
  return text;
}

type CopyButtonProps = Omit<ButtonProps, 'onClick' | 'children' | 'pending' | 'pendingLabel' | 'value' | 'pressed' | 'defaultPressed' | 'onPressedChange'> & {
  /** The text to copy, or a function that returns it (for values fetched on demand). */
  value: string | (() => string | Promise<string>);
  /** What is being copied, for the accessible name: "widget key" gives "Copy widget key". */
  label?: string;
  /** Show "Copy" and "Copied" as text next to the icon. */
  showLabel?: boolean;
  /** How long the confirmation stays, in ms. */
  timeout?: number;
  onCopy?: (value: string) => void;
  /** Shows one state without a press, for docs and visual tests. Presses still copy. */
  forceState?: Exclude<CopyState, 'idle'>;
};

function CopyButton({value, label, showLabel = false, timeout = 1600, onCopy, forceState, variant = 'ghost', size, className, ...props}: CopyButtonProps) {
  const [live, setState] = React.useState<CopyState>('idle');
  const [announcement, setAnnouncement] = React.useState('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const frame = React.useRef(0);
  React.useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(frame.current); }, []);
  const state = forceState ?? live;

  // Empty the region, then fill it on the next frame, so the same message twice is announced twice.
  const announce = (message: string) => {
    cancelAnimationFrame(frame.current);
    setAnnouncement('');
    frame.current = requestAnimationFrame(() => setAnnouncement(message));
  };

  const copy = async () => {
    clearTimeout(timer.current);
    try {
      let text: string;
      const result = typeof value === 'function' ? value() : value;
      if (typeof result === 'string') {
        text = result;
        await navigator.clipboard.writeText(text);
      } else {
        const writing = writeFetched(result);
        setState('fetching');
        text = await writing;
      }
      setState('copied');
      announce(label ? `${label} copied` : 'Copied');
      onCopy?.(text);
    } catch {
      setState('failed');
      announce('Could not copy. Select the text and copy it by hand.');
    }
    timer.current = setTimeout(() => { setState('idle'); setAnnouncement(''); }, timeout);
  };

  const glyph = state === 'copied' ? Checkmark : state === 'failed' ? Warning : Copy;
  const name = label ? `Copy ${label}` : 'Copy';
  const iconOnly = !showLabel;

  return <>
    <Button
      data-slot="copy-button"
      data-state={state}
      variant={variant}
      size={size ?? (iconOnly ? 'icon-sm' : 'sm')}
      aria-label={name}
      pending={state === 'fetching'}
      pendingLabel={showLabel ? 'Copy' : undefined}
      onClick={copy}
      className={className}
      {...props}
    >
      <Icon icon={glyph} size={16}/>
      {showLabel && <span className="grid [grid-template-areas:'stack']">
        <span aria-hidden className={cn('[grid-area:stack]', state !== 'idle' && state !== 'fetching' && 'invisible')}>Copy</span>
        <span aria-hidden className={cn('[grid-area:stack]', state !== 'copied' && 'invisible')}>Copied</span>
        <span aria-hidden className={cn('[grid-area:stack]', state !== 'failed' && 'invisible')}>Failed</span>
      </span>}
    </Button>
    <span role="status" data-slot="copy-button-status" className="sr-only fixed">{announcement}</span>
  </>;
}

export {CopyButton, type CopyButtonProps};
