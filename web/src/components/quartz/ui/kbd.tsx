'use client';

import {useSyncExternalStore} from 'react';
import {cn} from '@/lib/quartz/utils';

// A key on the keyboard. 20px tall, at least 20px wide, on the inner corner, in type-tag.
// Paper with a 1px control edge, so it reads as a key and not as a smaller grey chip. Inside a tooltip, a text hint or the
// sidebar's tooltip, which are whole data-surface="inverse" panels, the channels have already flipped, so paper and the
// edge work as is and only the text steps up to text-1. A combination is a KbdGroup of Kbds.
//
// `keys` writes a shortcut for the platform it is read on: keys="mod+k" is ⌘ K on a Mac and Ctrl K
// elsewhere, with the spoken name (Command K, Control K) for screen readers, so one string in the code
// never shows a Mac user Ctrl or a Windows user ⌘. The server cannot know the platform, so it renders a
// blank cap of the minimum width for each key that differs (mod, alt, ctrl, enter and the rest) and the
// keys that read the same everywhere as they are; the reader's own form fills in at hydration. Before,
// the server sent Ctrl, and a Mac painted it for a frame before swapping to ⌘.

type Platform = 'mac' | 'other';

const subscribe = () => () => {};
const detect = (): Platform => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other');
/** 'unknown' on the server and during hydration, until the client's platform is read. */
function usePlatform(): Platform | 'unknown' {
  return useSyncExternalStore<Platform | 'unknown'>(subscribe, detect, () => 'unknown');
}

/** Shown and spoken forms per key, Mac first. Anything else is shown as typed, upper-cased if one letter. */
const names: Record<string, {mac: string; other: string; spoken: {mac: string; other: string}}> = {
  mod: {mac: '⌘', other: 'Ctrl', spoken: {mac: 'Command', other: 'Control'}},
  cmd: {mac: '⌘', other: 'Win', spoken: {mac: 'Command', other: 'Windows'}},
  ctrl: {mac: '⌃', other: 'Ctrl', spoken: {mac: 'Control', other: 'Control'}},
  shift: {mac: '⇧', other: 'Shift', spoken: {mac: 'Shift', other: 'Shift'}},
  alt: {mac: '⌥', other: 'Alt', spoken: {mac: 'Option', other: 'Alt'}},
  enter: {mac: '↵', other: 'Enter', spoken: {mac: 'Return', other: 'Enter'}},
  esc: {mac: 'Esc', other: 'Esc', spoken: {mac: 'Escape', other: 'Escape'}},
  backspace: {mac: '⌫', other: 'Backspace', spoken: {mac: 'Delete', other: 'Backspace'}},
  tab: {mac: '⇥', other: 'Tab', spoken: {mac: 'Tab', other: 'Tab'}},
  space: {mac: 'Space', other: 'Space', spoken: {mac: 'Space', other: 'Space'}},
  up: {mac: '↑', other: '↑', spoken: {mac: 'Up arrow', other: 'Up arrow'}},
  down: {mac: '↓', other: '↓', spoken: {mac: 'Down arrow', other: 'Down arrow'}},
  left: {mac: '←', other: '←', spoken: {mac: 'Left arrow', other: 'Left arrow'}},
  right: {mac: '→', other: '→', spoken: {mac: 'Right arrow', other: 'Right arrow'}},
};

/** Splits "mod+shift+p" into its keys and gives each its shown and spoken form for a platform. */
function shortcut(keys: string, platform: Platform) {
  return keys.split('+').map(k => k.trim()).filter(Boolean).map(k => {
    const known = names[k.toLowerCase()];
    const shown = known ? known[platform] : k.length === 1 ? k.toUpperCase() : k;
    return {shown, spoken: known ? known.spoken[platform] : shown};
  });
}

const kbdClass = cn(
  // A long name wraps inside the cap (grows taller) instead of being cut or spilling out of it.
  'frame [--frame-radius:var(--radius-inner)] pointer-events-none inline-flex min-h-(--tag) w-fit max-w-full min-w-(--tag) items-center justify-center gap-1 bg-page px-1 text-center type-tag text-text-2 select-none [overflow-wrap:anywhere] [--frame-color:var(--line-control)]',
  'in-data-[slot=tooltip-content]:text-text-1 in-data-[slot=text-hint]:text-text-1 in-data-[slot=sidebar-tooltip]:text-text-1',
  'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1',
  '[&_svg]:size-3 [&_svg]:shrink-0',
);

type KbdProps = React.ComponentProps<'kbd'> & {
  /** A shortcut such as "mod+k" or "shift+enter", written for the reader's platform. Replaces children. */
  keys?: string;
};

function Kbd({className, keys, children, ...props}: KbdProps) {
  // keys="" is a shortcut with no keys: it renders nothing, not an empty cap.
  if (keys !== undefined) return <KbdShortcut keys={keys} className={className} {...props}/>;
  return <kbd data-slot="kbd" className={cn(kbdClass, className)} {...props}>{children}</kbd>;
}

function KbdShortcut({keys, className, ...props}: Omit<KbdProps, 'children'> & {keys: string}) {
  const platform = usePlatform();
  const parts = shortcut(keys, platform === 'unknown' ? 'other' : platform);
  // Until the platform is known, a key whose Mac and other forms differ is a blank cap.
  const neutral = platform === 'unknown' ? shortcut(keys, 'mac').map((m, i) => m.shown === parts[i].shown) : null;
  return <kbd
    data-slot="kbd-group"
    data-platform={platform === 'unknown' ? undefined : platform}
    className={cn('relative inline-flex max-w-full flex-wrap items-center gap-1 font-[inherit]', className)}
    {...props}
  >
    {parts.map((p, i) => neutral && !neutral[i]
      ? <kbd key={i} data-slot="kbd" data-placeholder="" aria-hidden className={kbdClass}/>
      : <kbd key={i} data-slot="kbd" aria-hidden className={kbdClass}>{p.shown}</kbd>)}
    {platform !== 'unknown' && <span className="sr-only">{parts.map(p => p.spoken).join(' ')}</span>}
  </kbd>;
}

function KbdGroup({className, ...props}: React.ComponentProps<'kbd'>) {
  return <kbd data-slot="kbd-group" className={cn('inline-flex max-w-full flex-wrap items-center gap-1 font-[inherit]', className)} {...props}/>;
}

export {Kbd, KbdGroup, shortcut, type KbdProps};
