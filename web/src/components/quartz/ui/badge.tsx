import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import type {Kind} from '@/lib/quartz/kind';
import {cn} from '@/lib/quartz/utils';

// Quartz's badge (useRender, cva, data-slot). A static label, one shape per meaning, so a reader
// can tell them apart in grayscale:
//
// - Tint, no line: a kind. `<Badge kind="run"/>` is one quiet word ("Run") in the kind's dark label step on its soft
//   tint, the one place hue fills. With no kind the tint is the neutral ink wash and the word is ink ("Beta").
// - Paper, a 1px line, ink text: an attribute that is trouble ("Over budget", "Revoked") or a plain outlined tag. The
//   line carries the colour (the warn or fail line step) and the word stays ink.
// - CodeTag: a method or a status code in mono, in the same outlined box. 5xx draws the fail line, 4xx the warn line.
//
// No badge takes ink: a thing waiting on a person is an InkSlot (status.tsx), and a pressed filter is a Chip. Two
// sizes: default 20px and sm 16px, both on the 4px inner corner with 12px text.
//
// A count takes `count` and `max`: past the cap it shows "99+" and keeps the exact number for screen readers and
// the title, so a cap never hides the real figure.

type BadgeStatus = 'warn' | 'fail';

const kindLabels: Record<Kind | BadgeStatus, string> = {
  agent: 'Agent',
  key: 'Key',
  run: 'Run',
  deploy: 'Deploy',
  model: 'Model',
  warn: 'Warning',
  fail: 'Failed',
};

// The outlined look: paper, the frame line in the colour the variant sets, ink text.
const outlined = 'frame [--frame-radius:var(--radius-inner)] bg-page text-text-1 [a]:hover:bg-hover';

const badgeVariants = cva(
  [
    'group/badge relative inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap rounded-inner',
    'transition-colors duration-(--dur-fast) ease-(--ease-step)',
    '[&>svg]:pointer-events-none [&>svg]:shrink-0',
    'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1',
  ],
  {
    variants: {
      // warn and destructive are deprecated spellings of status="warn" and status="fail".
      variant: {
        secondary: 'bg-accent-tint text-accent-label [a]:hover:bg-hover',
        outline: cn(outlined, '[--frame-color:var(--line-control)]'),
        ghost: 'bg-transparent text-text-2 [a]:hover:bg-hover [a]:hover:text-text-1',
        warn: cn(outlined, '[--frame-color:var(--accent-line)]'),
        destructive: cn(outlined, '[--frame-color:var(--accent-line)]'),
        link: 'h-auto px-0 text-text-1 underline-offset-4 decoration-1 [a]:hover:underline',
      },
      size: {
        default: 'min-h-(--tag) min-w-(--tag) gap-1 py-0.5 px-1.5 type-label-sm has-data-[icon=inline-start]:ps-1 has-data-[icon=inline-end]:pe-1',
        sm: 'min-h-4 min-w-4 gap-0.5 px-1 type-label-sm',
      },
    },
    defaultVariants: {variant: 'secondary', size: 'default'},
  },
);

type BadgeProps = useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & {
  /** The kind this badge names. Sets data-kind and shows the kind's word on its tint. */
  kind?: Kind;
  /** warn or fail, for a label that names trouble rather than a kind. Outlined in the reserved line step, ink text. */
  status?: BadgeStatus;
  /** Replaces the kind's word: `<Badge kind="run" label="Nightly run"/>`. */
  label?: React.ReactNode;
  /** A count. With `max`, values past it show as "max+"; the exact number stays in the accessible name. */
  count?: number;
  /** The cap for `count`. 99 by default. */
  max?: number;
};

function Badge({className, variant, size = 'default', kind, status, label, count, max = 99, render, children, ...props}: BadgeProps) {
  const tone = status ?? (variant === 'destructive' ? 'fail' : variant === 'warn' ? 'warn' : undefined);
  const named = kind ?? status;
  const capped = count !== undefined && count > max;
  const word = label ?? children ?? (named ? kindLabels[named] : undefined);
  const shown = count === undefined ? word : capped ? `${max}+` : count.toLocaleString('en-US');
  // Trouble is outlined whatever variant was asked for; a kind keeps the asked variant, the tint by default.
  const look = tone ? (tone === 'fail' ? 'destructive' : 'warn') : variant;
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({variant: look, size}), className),
        children: capped ? <><span aria-hidden>{shown}</span><span className="sr-only">{count.toLocaleString('en-US')}</span></> : shown,
      },
      {'data-slot': 'badge', 'data-kind': kind, 'data-status': tone, 'data-size': size, title: capped ? count.toLocaleString('en-US') : undefined} as React.ComponentProps<'span'>,
      props,
    ),
    render,
    state: {slot: 'badge', variant},
  });
}

type CodeTagStatus = 'neutral' | 'warn' | 'fail';
/** @deprecated Use CodeTagStatus. */
type CodeTagTone = CodeTagStatus;

/** The status an HTTP status code reads in: 5xx fail, 4xx warn, everything else neutral. */
function codeStatus(code: number | string | undefined): CodeTagStatus {
  const n = Number(code);
  if (!Number.isInteger(n)) return 'neutral';
  if (n >= 500 && n < 600) return 'fail';
  if (n >= 400 && n < 500) return 'warn';
  return 'neutral';
}

type CodeTagProps = React.ComponentProps<'span'> & {
  /** An HTTP status code. Shown as the text unless children replace it, and picks the status. */
  code?: number | string;
  /** Overrides the status `code` picks. A method stays neutral: DELETE is not trouble. */
  status?: CodeTagStatus;
  /** @deprecated Use status. */
  tone?: CodeTagStatus;
  /** soft: a grey fill (default). solid: an ink fill with paper text, or the status's mark (amber, red) with dark text at 5:1 or better, for a status code you scan a column of. outline: a line and no fill, for a method beside a solid code. */
  fill?: 'soft' | 'solid' | 'outline';
};

/**
 * A code, a method or a status code in mono, in a 20px box: `<CodeTag code={503}/>`, `<CodeTag>POST</CodeTag>`.
 * Three fills. soft (default): a grey fill, with the status's line for 4xx and 5xx. solid: ink with paper text, or
 * the status's mark (amber, red) as the fill with dark text, for a column of status codes. outline: a line only, for a method set
 * beside a solid code. The text never takes a hue of its own.
 */
function CodeTag({code, status, tone, fill = 'soft', className, children, ...props}: CodeTagProps) {
  const t = status ?? tone ?? codeStatus(code);
  return <span
    data-slot="code-tag"
    data-fill={fill}
    data-status={t === 'neutral' ? undefined : t}
    className={cn(
      'frame [--frame-radius:var(--radius-inner)] inline-flex h-(--tag) min-w-(--tag) shrink-0 items-center justify-center px-1.5 type-tag whitespace-nowrap text-text-1',
      'data-[fill=soft]:bg-selected data-[fill=soft]:[--frame-color:transparent] data-[fill=soft]:data-status:[--frame-color:var(--accent-line)]',
      'data-[fill=solid]:bg-inverse data-[fill=solid]:text-text-inverse data-[fill=solid]:[--frame-color:transparent] data-[fill=solid]:data-status:bg-(--accent-mark) data-[fill=solid]:data-status:text-on-field',
      'data-[fill=outline]:bg-page data-[fill=outline]:[--frame-color:var(--line-control)] data-[fill=outline]:data-status:[--frame-color:var(--accent-line)]',
      'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1',
      className,
    )}
    {...props}
  >{children ?? code}</span>;
}

/** @deprecated Use codeStatus. */
const codeTone = codeStatus;

export {Badge, badgeVariants, CodeTag, codeStatus, codeTone, kindLabels, type BadgeProps, type BadgeStatus, type CodeTagProps, type CodeTagStatus, type CodeTagTone};
