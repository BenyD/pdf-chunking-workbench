import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva} from 'class-variance-authority';
import {Icon, Close} from '@/components/quartz/icon';
import type {Kind} from '@/lib/quartz/kind';
import {cn} from '@/lib/quartz/utils';

// A resource named in a prompt or an answer: "@refund-policy.md", "@run 4812", "/refund". One inline box, 20px
// tall so it sits in a 14/20 line without moving it, the 4px inner corner, paper with a 1px inside line and ink text.
//
// It is in the code tag's family: the line carries the colour and the text stays ink. A mention of a kind (agent,
// run, deploy, key, model) takes its line from the kind's line step; files, folders, docs, tables, web pages,
// commands and pasted text take the control line. That keeps it apart from a Badge, which names a kind with a tinted
// fill and no line: "Run" the kind against "run 4812" the thing. The line is an inset shadow from --mention-line,
// not a frame, because it sits inline in a line of text. There is no icon.
//
// One chip, one serialized form. `mentionToText` writes a chip as `[label](type:id)` and `parseMentions`
// reads it back, so a chip copied out of the composer, through any clipboard, comes back a chip. The
// composer (prompt-input) clones this exact markup into its editor, so a chip typed, picked or pasted
// looks the same as one in a message. Keep the DOM flat: label, optional remove.

type MentionType = Kind | 'file' | 'folder' | 'doc' | 'table' | 'web' | 'command' | 'paste';

/** One mention as data: what the chip stands for. `id` is the stable key; `label` is what shows. */
type MentionRef = {id: string; type: MentionType; label: string};

const mentionTypeLabels: Record<MentionType, string> = {
  agent: 'Agent', run: 'Run', deploy: 'Deployment', key: 'Key', model: 'Model',
  file: 'File', folder: 'Folder', doc: 'Doc', table: 'Table', web: 'Web page', command: 'Command', paste: 'Pasted text',
};

const kindTypes = new Set<MentionType>(['agent', 'run', 'deploy', 'key', 'model']);
const isMentionKind = (type: MentionType): type is Kind => kindTypes.has(type);
const mentionTypes = new Set(Object.keys(mentionTypeLabels));

// ---------- The serialized form ----------

// A lone surrogate half cannot be URI-encoded (encodeURIComponent throws), so it becomes U+FFFD first.
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** An id as it sits in the text form. encodeURIComponent leaves parens alone, and a ")" would end the link. */
const encodeMentionId = (id: string) => encodeURIComponent(id.replace(loneSurrogate, '�')).replace(/[()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const labelEscapes: Record<string, string> = {'\\': '\\\\', '[': '\\[', ']': '\\]', '\n': '\\n', '\r': '\\r'};
const labelUnescapes: Record<string, string> = {n: '\n', r: '\r'};

/**
 * `[label](type:id)`. Brackets, backslashes and line breaks in a label are escaped and parens in the id
 * encoded, so every chip, an empty id or label included, parses back to itself.
 */
function mentionToText({type, id, label}: MentionRef) {
  return `[${label.replace(/[\\[\]\n\r]/g, m => labelEscapes[m])}](${type}:${encodeMentionId(id)})`;
}

// An optional @ or / in front is the legacy prefix; it is read and dropped.
const tokenPattern = /[@/]?\[((?:\\.|[^\]\\\n])*)\]\(([a-z]+):([^)\s]*)\)/g;

type MentionToken = {kind: 'text'; text: string} | {kind: 'mention'; mention: MentionRef};

/** Splits text into plain runs and mentions. Unknown types stay text, so a markdown link is never eaten. */
function parseMentions(source: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  let last = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const [whole, rawLabel, type, rawId] = match;
    if (!mentionTypes.has(type)) continue;
    let id = rawId;
    try { id = decodeURIComponent(rawId); } catch {}
    if (match.index > last) tokens.push({kind: 'text', text: source.slice(last, match.index)});
    tokens.push({kind: 'mention', mention: {type: type as MentionType, id, label: rawLabel.replace(/\\(.)/g, (_, c: string) => labelUnescapes[c] ?? c)}});
    last = match.index + whole.length;
  }
  if (last < source.length) tokens.push({kind: 'text', text: source.slice(last)});
  return tokens;
}

/**
 * A label no other chip in `taken` uses: "policy.md", then "policy.md (2)". Two different files with the
 * same name never collapse into one chip, and the same id keeps its label.
 */
function uniqueLabel(next: MentionRef, taken: MentionRef[]) {
  const same = taken.find(m => m.type === next.type && m.id === next.id);
  if (same) return same.label;
  const labels = new Set(taken.map(m => m.label));
  if (!labels.has(next.label)) return next.label;
  let n = 2;
  while (labels.has(`${next.label} (${n})`)) n += 1;
  return `${next.label} (${n})`;
}

// ---------- The chip ----------

const mentionVariants = cva(
  [
    'group/mention inline-flex min-h-5 max-w-full min-w-0 items-center gap-1 rounded-inner bg-page px-1.5 align-bottom whitespace-nowrap',
    'shadow-[inset_0_0_0_1px_var(--mention-line)] [--mention-line:var(--line-control)] data-kind:[--mention-line:var(--accent-line)]',
    'type-label text-text-1 no-underline select-none',
    'transition-[background-color,outline-color] duration-(--dur-fast) ease-(--ease-step)',
    '[a]:hover:bg-hover [button]:hover:bg-hover [a,button]:cursor-pointer',
    'aria-disabled:text-text-disabled data-missing:text-text-3 data-missing:line-through data-missing:decoration-1 data-missing:[--mention-line:var(--line-row)]',
    'forced-colors:outline forced-colors:outline-1 forced-colors:-outline-offset-1',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {removable: {true: 'pe-0', false: ''}},
    defaultVariants: {removable: false},
  },
);

type MentionProps = useRender.ComponentProps<'span'> & {
  /** What is mentioned. A kind takes its line step; the rest take the control line. */
  type: MentionType;
  /** The visible name: a file path, a run number, a command. Commands get their slash from here. */
  children: React.ReactNode;
  /** The source no longer exists. The chip keeps its place, struck through, and says so to screen readers. */
  missing?: boolean;
  /** Adds a remove button inside the chip, for chips in an editable list. After removal focus moves to the
   *  next chip's remove button in the same list (ul, ol, role=list or role=group), else the previous. */
  onRemove?: () => void;
  /** Accessible name of the remove button. Defaults to "Remove <label>". */
  removeLabel?: string;
  /** Read after a missing chip's label: " (no longer exists)". For another language. */
  missingLabel?: string;
};

function Mention({type, missing, onRemove, removeLabel, missingLabel = ' (no longer exists)', render, className, children, ...props}: MentionProps) {
  const text = typeof children === 'string' ? children : undefined;
  // The remove button is 20px so the chip's line does not grow, which is why it is not a Button: after:-inset-1 makes its
  // target 28px, and a coarse pointer gets 24px.
  const label = <>
    <span data-slot="mention-label" className="min-w-0 truncate" title={text && text.length > 24 ? text : undefined}>{type === 'command' ? '/' : ''}{children}</span>
    {missing && <span className="sr-only">{missingLabel}</span>}
    {onRemove && <button
      type="button"
      data-slot="mention-remove"
      aria-label={removeLabel ?? `Remove ${text ?? mentionTypeLabels[type]}`}
      onClick={event => {
        // The button unmounts with its chip. Hand focus to the next chip's remove button in the same list,
        // else the previous one; with none left, the caller's onRemove decides (focus your field there).
        const list = event.currentTarget.closest('ul, ol, [role="list"], [role="group"]') ?? event.currentTarget.parentElement?.parentElement;
        const all = list ? [...list.querySelectorAll<HTMLElement>('[data-slot="mention-remove"]')] : [];
        const at = all.indexOf(event.currentTarget);
        const next = all[at + 1] ?? all[at - 1];
        onRemove();
        requestAnimationFrame(() => {
          const active = document.activeElement;
          if (next?.isConnected && (!active || active === document.body || !active.isConnected)) next.focus();
        });
      }}
      className="relative inline-flex size-5 shrink-0 items-center justify-center rounded-inner text-text-2 pointer-coarse:-my-0.5 pointer-coarse:size-6 transition-colors duration-(--dur-fast) ease-(--ease-step) after:absolute after:-inset-1 hover:bg-hover hover:text-text-1"
    ><Icon icon={Close} size={12}/></button>}
  </>;
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {className: cn(mentionVariants({removable: !!onRemove}), className), children: label},
      {'data-slot': 'mention', 'data-kind': isMentionKind(type) ? type : undefined, 'data-type': type, 'data-missing': missing || undefined} as React.ComponentProps<'span'>,
      props,
    ),
    render,
    state: {slot: 'mention', type},
  });
}

export {
  Mention, mentionVariants, mentionTypeLabels, isMentionKind, mentionToText, encodeMentionId, parseMentions, uniqueLabel,
  type MentionType, type MentionProps, type MentionRef, type MentionToken,
};
