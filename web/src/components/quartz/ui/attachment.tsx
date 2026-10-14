'use client';

import * as React from 'react';
import {Button as ButtonPrimitive} from '@base-ui/react/button';
import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import {
  Icon, Renew, CircleDash, DocumentBlank, Archive, DocumentAudio, Code, Csv, DocumentWordProcessor, Image, DocumentPdf, Document, DocumentVideo, Upload, ErrorOutline, type QuartzIcon,
} from '@/components/quartz/icon';
import type {Kind} from '@/lib/quartz/kind';
import {Button, type ButtonProps} from '@/components/quartz/ui/button';
import {Truncate} from '@/components/quartz/ui/truncate';
import {cn, mergeClass, mergeRefs} from '@/lib/quartz/utils';
import {formatBytes, formatByteProgress} from '@/lib/quartz/format';

// Quartz's attachment: a file in a form, a prompt or a message (was Attachment, File drop and Upload
// preview). Three parts of one job:
// - Attachment: the file as a chip or a card, with upload progress and the reason it failed.
// - AttachmentDrop: a region that takes files dragged onto it, or a visible zone with a browse button.
// - Attachment variant="tile": a square image slot that is its own upload button (an agent avatar).
//
// The detail that comes from the job: a drop is judged before the person lets go. While a drag is over
// the region, a file it cannot take (wrong type) turns the overlay to the fail field and says why, so
// nobody drops a .zip onto an images-only composer and waits to find out. What passes the drag is checked
// again on drop (size, count), and every rejection comes back with a reason the chip can show.
//
// The chip: one 40px row on paper with a frame in the control line and the 6px soft corner.
// The media cell is a 40px square on the tile field, split from the rest by a control line; then the name, cut in
// the middle so the extension stays, and the size or status in tabular figures underneath; then 28px ghost actions.
// The composer's file (PromptAttachment) renders this chip too, so a file reads the same everywhere. Five states:
// - idle: picked but not sent yet.
// - uploading: a 2px ink bar along the chip's bottom inside edge fills to the percent; the media dims to 60%.
// - processing: uploaded, the server is still reading it: the media dims like an upload.
// - done: uploaded. The default.
// - error: failed or rejected. The chip takes the fail wash through data-status="fail", and the reason reads
//   in the fail text step, so the hue never needs naming here.
// Images show a thumbnail; anything else shows the glyph for its type (fileGlyph below).

type AttachmentState = 'idle' | 'uploading' | 'processing' | 'done' | 'error';

const attachmentVariants = cva(
  [
    'group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 bg-page text-text-1 frame [--frame-color:var(--line-control)]',
    'data-[state=error]:bg-accent-wash',
    // A whole-chip trigger tints the chip on hover; the actions sit above it and keep their own hover.
    'has-[>[data-slot=attachment-trigger]:hover]:bg-hover data-[state=error]:has-[>[data-slot=attachment-trigger]:hover]:bg-accent-wash',
  ],
  {
    variants: {
      size: {
        default: '[--attachment-media:var(--row)]',
        sm: '[--attachment-media:var(--row-sm)]',
      },
      orientation: {
        horizontal: 'min-w-48 items-center pe-3 has-[>[data-slot=attachment-actions]]:pe-1.5 [--frame-radius:var(--radius-soft)]',
        vertical: 'w-28 flex-col',
      },
    },
    compoundVariants: [
      {orientation: 'horizontal', size: 'sm', className: 'min-w-40 has-[>[data-slot=attachment-actions]]:pe-1'},
    ],
    defaultVariants: {size: 'default', orientation: 'horizontal'},
  },
);

type AttachmentChipProps = React.ComponentProps<'div'> & VariantProps<typeof attachmentVariants> & {
  variant?: 'chip';
  state?: AttachmentState;
};
type AttachmentProps = AttachmentChipProps | AttachmentTileProps;

/** A file as a chip or card; variant="tile" is the square image slot that uploads on press. */
function Attachment(props: AttachmentProps) {
  if (props.variant === 'tile') return <AttachmentTile {...props}/>;
  return <AttachmentChip {...props}/>;
}

function AttachmentChip({className, state = 'done', size = 'default', orientation = 'horizontal', variant: _variant, ...props}: AttachmentChipProps) {
  return <div
    data-slot="attachment"
    data-variant="chip"
    data-state={state}
    data-size={size}
    data-orientation={orientation}
    data-status={state === 'error' ? 'fail' : undefined}
    aria-busy={state === 'uploading' || state === 'processing' || undefined}
    className={cn(attachmentVariants({size, orientation}), className)}
    {...props}
  />;
}

// The media cell fills the chip's height and shares its control line with the content beside it (below it on a card).
const attachmentMediaVariants = cva(
  [
    'relative flex aspect-square shrink-0 items-center justify-center overflow-hidden text-text-1',
    'size-(--attachment-media) shadow-[inset_-1px_0_0_var(--line-control)] rtl:shadow-[inset_1px_0_0_var(--line-control)]',
    'group-data-[orientation=vertical]/attachment:size-auto group-data-[orientation=vertical]/attachment:w-full group-data-[orientation=vertical]/attachment:shadow-[inset_0_-1px_0_var(--line-control)]',
    'group-data-[state=uploading]/attachment:*:opacity-(--stale-opacity) group-data-[state=processing]/attachment:*:opacity-(--stale-opacity)',
    // A failed file keeps its glyph on the tile; the chip already carries the wash and the row says why in fail text.
    '[&_svg]:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        icon: 'bg-tile',
        image: [
          'bg-tile *:[img]:size-full *:[img]:object-cover',
          'group-data-[state=uploading]/attachment:*:[img]:opacity-(--stale-opacity) group-data-[state=processing]/attachment:*:[img]:opacity-(--stale-opacity)',
        ],
      },
    },
    defaultVariants: {variant: 'icon'},
  },
);

function AttachmentMedia({className, variant = 'icon', children, ref: callerRef, ...props}: React.ComponentProps<'div'> & VariantProps<typeof attachmentMediaVariants>) {
  // An image thumbnail that fails to decode falls back to the image file glyph, as the tile does, instead
  // of the browser's broken-image icon. error does not bubble, so listen in the capture phase.
  const ref = React.useRef<HTMLDivElement>(null);
  const setRef = React.useMemo(() => mergeRefs(ref, callerRef), [callerRef]);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => {
    const node = ref.current;
    if (!node || variant !== 'image') return;
    const onError = (event: Event) => { if ((event.target as HTMLElement).tagName === 'IMG') setBroken(true); };
    node.addEventListener('error', onError, true);
    const img = node.querySelector('img');
    if (img?.getAttribute('src') && img.complete && img.naturalWidth === 0) setBroken(true); // failed before hydration
    return () => node.removeEventListener('error', onError, true);
  }, [variant]);
  return <div
    ref={setRef}
    data-slot="attachment-media"
    data-variant={broken ? 'icon' : variant}
    className={cn(attachmentMediaVariants({variant: broken ? 'icon' : variant}), className)}
    {...props}
  >
    {broken ? <Icon icon={Image} size={20}/> : children}
  </div>;
}

function AttachmentContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="attachment-content"
    className={cn('flex min-w-0 flex-1 flex-col gap-0.5 px-3 group-data-[orientation=vertical]/attachment:w-full group-data-[orientation=vertical]/attachment:px-2 group-data-[orientation=vertical]/attachment:py-1.5', className)}
    {...props}
  />;
}

/** Keeps the extension and a few characters before it, so trace-2026-09-30.json reads trace-20…-30.json. */
function tailOf(name: string) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.length - dot : 0;
  return Math.min(name.length, ext + 4);
}

/** The file name. A plain string is cut in the middle so the extension always shows. */
function AttachmentTitle({className, children, ...props}: React.ComponentProps<'span'>) {
  return <span
    data-slot="attachment-title"
    className={cn('flex min-w-0 type-label text-text-1 group-data-[size=sm]/attachment:type-label-sm', className)}
    {...props}
  >
    {typeof children === 'string' ? <Truncate position="middle" tail={tailOf(children)} focusable={false}>{children}</Truncate> : children}
  </span>;
}

/** Size, progress or the reason it failed. Tabular figures, so a counting size never jitters. */
function AttachmentDescription({className, ...props}: React.ComponentProps<'span'>) {
  return <span
    data-slot="attachment-description"
    className={cn('block min-w-0 truncate type-label-sm text-text-3 data group-data-[state=error]/attachment:text-fail-text group-data-[size=sm]/attachment:hidden', className)}
    {...props}
  />;
}

type AttachmentProgressProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  /** 0 to 100. */
  value: number;
  /** What is uploading, for the progressbar's name. */
  label: string;
};

/**
 * A 2px ink bar along the chip's bottom inside edge that fills to the percent; the same figure
 * stays in the description and in aria-valuenow. Plain markup with role="progressbar", so it never depends
 * on another component. Render it only while uploading.
 */
function AttachmentProgress({value, label, className, ...props}: AttachmentProgressProps) {
  const clamped = Math.min(100, Math.max(0, Math.round(value)));
  return <div
    data-slot="attachment-progress"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={clamped}
    aria-valuetext={`${clamped}%`}
    className={cn('pointer-events-none absolute inset-x-0 bottom-0 h-0.5', className)}
    {...props}
  >
    <div className="h-full bg-ink transition-[width] duration-(--dur-fast) ease-(--ease-step) motion-reduce:transition-none forced-colors:bg-[CanvasText]" style={{width: `${clamped}%`}}/>
  </div>;
}

function AttachmentActions({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="attachment-actions"
    className={cn(
      'relative z-(--z-above) flex shrink-0 items-center gap-0.5',
      'group-data-[orientation=vertical]/attachment:absolute group-data-[orientation=vertical]/attachment:top-2 group-data-[orientation=vertical]/attachment:end-2',
      className,
    )}
    {...props}
  />;
}

/** A 28px icon button: remove, retry, download. Always give it an aria-label that names the file. */
function AttachmentAction({className, variant, size = 'icon-sm', ...props}: ButtonProps) {
  return <Button
    data-slot="attachment-action"
    variant={variant ?? 'ghost'}
    size={size}
    className={mergeClass(// On a thumbnail the action needs its own field to read against the picture.
      'group-data-[orientation=vertical]/attachment:bg-page group-data-[size=sm]/attachment:size-6', className)}
    {...props}
  />;
}

/** Makes the whole chip one button (open a preview), under the actions. */
function AttachmentTrigger({className, render, type, ...props}: useRender.ComponentProps<'button'>) {
  return useRender({
    defaultTagName: 'button',
    props: mergeProps<'button'>(
      {
        type: render ? type : (type ?? 'button'),
        className: cn('absolute inset-0 z-(--z-raised) rounded-[inherit] focus-visible:z-(--z-cover)', className),
      },
      {...props, 'data-slot': 'attachment-trigger'} as React.ComponentProps<'button'>,
    ),
    render,
  });
}

const attachmentGroupVariants = cva('flex min-w-0 gap-2', {
  variants: {
    layout: {
      wrap: 'flex-wrap',
      scroll: 'snap-x snap-mandatory overflow-x-auto overscroll-x-contain py-1 [scrollbar-width:none] *:data-[slot=attachment]:flex-none *:data-[slot=attachment]:snap-start [&::-webkit-scrollbar]:hidden',
    },
  },
  defaultVariants: {layout: 'wrap'},
});

/** The files on one prompt or message. Wraps by default; scroll keeps a composer one row tall. */
function AttachmentGroup({className, layout = 'wrap', ...props}: React.ComponentProps<'div'> & VariantProps<typeof attachmentGroupVariants>) {
  return <div
    data-slot="attachment-group"
    data-layout={layout}
    role="group"
    className={cn(attachmentGroupVariants({layout}), className)}
    {...props}
  />;
}

// ---------- Helpers ----------

const glyphs: [RegExp, QuartzIcon][] = [
  [/^image\/|\.(png|jpe?g|gif|webp|avif|svg|heic)$/i, Image],
  [/^video\/|\.(mp4|mov|webm)$/i, DocumentVideo],
  [/^audio\/|\.(mp3|wav|m4a|ogg)$/i, DocumentAudio],
  [/pdf$|\.pdf$/i, DocumentPdf],
  [/csv$|\.(csv|tsv)$/i, Csv],
  [/zip|tar|gzip|\.(zip|tar|gz|tgz)$/i, Archive],
  [/json|javascript|typescript|x-python|yaml|\.(json|jsonl|js|ts|tsx|py|ya?ml|toml|sh|go|rs)$/i, Code],
  [/wordprocessing|msword|\.(docx?|odt|rtf)$/i, DocumentWordProcessor],
  [/^text\/|\.(txt|md|log)$/i, Document],
];

/** The glyph for a file, from its MIME type or its name. Falls back to a plain file. */
function fileGlyph(type: string, name = ''): QuartzIcon {
  for (const [pattern, glyph] of glyphs) if (pattern.test(type) || pattern.test(name)) return glyph;
  return DocumentBlank;
}

/** "1.2 of 4.8 MB": both numbers in the total's unit. The size formatters live in lib/format, shared with the composer. */
const formatProgress = formatByteProgress;

/** The type glyph: 20px in a default chip, 16 in a small one, 24 on a vertical card. */
function AttachmentGlyph({type, name, size = 20, className}: {type: string; name?: string; size?: 16 | 20 | 24; className?: string}) {
  return <Icon icon={fileGlyph(type, name)} size={size} className={className}/>;
}


// ---------- Drop ----------

type FileRejection = {file: File; reason: 'type' | 'size' | 'count'};

type AttachmentDropContextValue = {
  open: () => void;
  disabled: boolean;
  dragging: false | 'accept' | 'reject';
  accept?: string;
  multiple: boolean;
  inputId: string;
  variant: 'region' | 'zone';
};

const AttachmentDropContext = React.createContext<AttachmentDropContextValue | null>(null);

function useAttachmentDrop() {
  const context = React.useContext(AttachmentDropContext);
  if (!context) throw new Error('useAttachmentDrop must be used within <AttachmentDrop>');
  return context;
}

// ---------- Matching ----------

/** Splits an accept string ("image/*,.pdf,application/json") into lower-case tokens. */
function acceptTokens(accept?: string) {
  return (accept ?? '').split(',').map(token => token.trim().toLowerCase()).filter(Boolean);
}

/** Whether a MIME type (and a name, when there is one) matches the accept tokens. */
function matches(tokens: string[], type: string, name?: string) {
  if (!tokens.length) return true;
  const mime = type.toLowerCase();
  const lower = name?.toLowerCase();
  return tokens.some(token => {
    if (token.startsWith('.')) return lower ? lower.endsWith(token) : false;
    if (token.endsWith('/*')) return mime.startsWith(token.slice(0, -1));
    return mime === token;
  });
}

/** During a drag only types are known, not names. An accept with any extension in it is judged at the drop. */
function dragVerdict(tokens: string[], items: DataTransferItemList | undefined): 'accept' | 'reject' {
  if (!items || !tokens.length) return 'accept';
  const files = Array.from(items).filter(item => item.kind === 'file');
  if (!files.length) return 'reject';
  const judgeable = tokens.every(token => !token.startsWith('.'));
  if (!judgeable) return 'accept';
  return files.some(item => !item.type || matches(tokens, item.type)) ? 'accept' : 'reject';
}

/** "images and PDFs" from "image/*,.pdf": the accept string in words, for the reject overlay. */
function describeAccept(accept: string) {
  const named: Record<string, string> = {plain: 'text', markdown: 'Markdown', jsonl: 'JSONL', 'x-python': 'Python', gzip: 'gzip'};
  const word = (sub: string) => named[sub] ?? (sub.length <= 4 ? sub.toUpperCase() : sub);
  const words = [...new Set(acceptTokens(accept).map(t => t.endsWith('/*') ? `${t.slice(0, -2)}s` : t.startsWith('.') ? word(t.slice(1)) : word(t.split('/').pop()!)))];
  const list = words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
  return words.every(w => w.endsWith('s') && w === w.toLowerCase()) ? list : `${list} files`;
}

function hasFiles(event: React.DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

// ---------- Root ----------

// A region wrapped around a composer holds its text field. The box shows the field's focus by turning its edge
// ink, and the field draws no outline of its own, so a focused composer has one edge, not a second one inside.
const attachmentDropVariants = cva([
  'group/attachment-drop relative',
  '[&_textarea:focus-visible]:outline-none',
  'has-[textarea:focus]:[--frame-color:var(--border-focus)]!',
], {
  variants: {
    variant: {
      // Invisible until a drag. For composers, panels and pages.
      region: '',
      // A visible paper frame in the control line, its words and browse button anchored top-left. For settings and
      // import screens.
      zone: 'flex flex-col items-start gap-3 bg-page px-4 py-6 text-start frame [--frame-color:var(--line-control)] data-disabled:text-text-disabled',
    },
  },
  defaultVariants: {variant: 'region'},
});

type AttachmentDropProps = Omit<React.ComponentProps<'div'>, 'onDrop'> & VariantProps<typeof attachmentDropVariants> & {
  /** Same syntax as the input's accept: MIME types, wildcards and extensions. */
  accept?: string;
  /** Largest file in bytes. */
  maxSize?: number;
  /** More than one file per drop or pick. On by default. */
  multiple?: boolean;
  /** Takes nothing; the overlay never shows and the trigger is disabled. */
  disabled?: boolean;
  /** Takes files pasted (usually screenshots) while focus is inside the region. */
  paste?: boolean;
  /** The files that passed every check, in the order they came. */
  onFiles?: (files: File[]) => void;
  /** The files that did not, each with a reason. */
  onReject?: (rejections: FileRejection[]) => void;
  /** The hue of the overlay field. Leave out for the grey field. */
  kind?: Kind;
  /** The overlay's line while a drag can drop. */
  overlayLabel?: React.ReactNode;
  /** The overlay's line while a drag cannot. */
  rejectLabel?: React.ReactNode;
  /** Shows the overlay without a drag, for docs, tests and screenshots. */
  dragState?: 'accept' | 'reject';
};

// A drag or drop event the innermost region has already handled. Regions nest (a composer inside a page
// that takes files), and the event bubbles through both: the inner one claims it, and the outer one sees
// the claim, hides its overlay and takes nothing. Propagation is not stopped, so window listeners still
// hear the drop.
const claimed = new WeakSet<Event>();

function AttachmentDrop({
  accept, maxSize, multiple = true, disabled = false, paste = false, onFiles, onReject, kind,
  overlayLabel, rejectLabel, dragState, variant = 'region', className, children, onPaste, ...props
}: AttachmentDropProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const depth = React.useRef(0);
  const [dragging, setDragging] = React.useState<false | 'accept' | 'reject'>(false);
  const [covered, setCovered] = React.useState(false);
  const inputId = React.useId();
  const tokens = React.useMemo(() => acceptTokens(accept), [accept]);

  const take = (list: File[]) => {
    const accepted: File[] = [];
    const rejected: FileRejection[] = [];
    for (const file of list) {
      if (!matches(tokens, file.type, file.name)) rejected.push({file, reason: 'type'});
      else if (maxSize !== undefined && file.size > maxSize) rejected.push({file, reason: 'size'});
      else if (!multiple && accepted.length >= 1) rejected.push({file, reason: 'count'});
      else accepted.push(file);
    }
    if (accepted.length) onFiles?.(accepted);
    if (rejected.length) onReject?.(rejected);
  };

  const reset = () => { depth.current = 0; setDragging(false); setCovered(false); };
  /** True when a nested region already took this event; marks it taken otherwise. */
  const nested = (event: React.DragEvent) => {
    if (claimed.has(event.nativeEvent)) return true;
    if (!disabled) claimed.add(event.nativeEvent);
    return false;
  };

  // A drag that ends outside the region (Escape, a drop elsewhere) never fires dragleave here.
  React.useEffect(() => {
    if (!dragging) return;
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset); };
  }, [dragging]);

  const dragHandlers = {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (disabled) return;
      depth.current += 1;
      setDragging(dragVerdict(tokens, event.dataTransfer.items));
    },
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      // Always claim the drag, so a file dropped on a disabled region never opens in the tab.
      event.preventDefault();
      const inner = nested(event);
      if (inner !== covered) setCovered(inner);
      if (inner) return;
      event.dataTransfer.dropEffect = disabled || dragging === 'reject' ? 'none' : 'copy';
    },
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event) || disabled) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (event: React.DragEvent<HTMLDivElement>) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      reset();
      if (disabled || nested(event)) return;
      take(Array.from(event.dataTransfer.files));
    },
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    onPaste?.(event);
    if (!paste || disabled || event.defaultPrevented) return;
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return; // plain text paste goes through untouched
    event.preventDefault();
    take(files);
  };

  const open = () => { if (!disabled) inputRef.current?.click(); };
  const shown = disabled ? false : (dragState ?? (covered ? false : dragging));

  return <AttachmentDropContext.Provider value={{open, disabled, dragging: shown, accept, multiple, inputId, variant: variant ?? 'region'}}>
    <div
      data-slot="attachment-drop"
      data-variant={variant}
      data-kind={kind}
      data-dragging={shown || undefined}
      data-disabled={disabled || undefined}
      aria-disabled={disabled || undefined}
      className={cn(attachmentDropVariants({variant}), className)}
      onPaste={handlePaste}
      {...dragHandlers}
      {...props}
    >
      {children}
      <AttachmentDropOverlay label={overlayLabel} rejectLabel={rejectLabel}/>
      <input
        ref={inputRef}
        id={inputId}
        data-slot="attachment-drop-input"
        type="file"
        tabIndex={-1}
        aria-hidden
        hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={event => {
          take(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = ''; // so picking the same file again still fires
        }}
      />
    </div>
  </AttachmentDropContext.Provider>;
}

// ---------- Overlay ----------

/**
 * Shown only while a drag is over the region: the region's frame turns ink over the accent wash (the selected wash,
 * or the kind's), or the fail wash when the drag cannot drop, with the words top-left. A reject says why in the fail
 * text step. Hidden from assistive tech: dragging is a pointer gesture, and the trigger carries the same meaning for
 * everyone else.
 */
function AttachmentDropOverlay({label, rejectLabel, icon = Upload}: {label?: React.ReactNode; rejectLabel?: React.ReactNode; icon?: QuartzIcon}) {
  const {dragging, multiple, accept} = useAttachmentDrop();
  if (!dragging) return null;
  const reject = dragging === 'reject';
  return <div
    data-slot="attachment-drop-overlay"
    data-status={reject ? 'fail' : undefined}
    aria-hidden
    className={cn(
      'pointer-events-none absolute inset-0 z-(--z-drop) flex flex-col items-start gap-1 bg-accent-wash px-4 py-3 text-start text-text-1 frame [--frame-color:var(--ink)] data-[status=fail]:[--frame-color:var(--fail-line)]',
      'forced-colors:border-2 forced-colors:border-dashed forced-colors:border-[CanvasText]',
    )}
  >
    {icon !== Upload && <Icon icon={reject ? ErrorOutline : icon} size={16} className="text-text-2"/>}
    <span className="type-label">{label ?? (multiple ? 'Drop files to attach' : 'Drop a file to attach')}</span>
    {reject && <span className="type-body-sm text-fail-text">{rejectLabel ?? (accept ? `Only ${describeAccept(accept)} can be added here` : 'These files cannot be added here')}</span>}
  </div>;
}

// ---------- Zone parts ----------

function AttachmentDropIcon({icon = Upload, className}: {icon?: QuartzIcon; className?: string}) {
  return <span data-slot="attachment-drop-icon" className={cn('flex size-8 items-center justify-center text-text-2', className)}>
    <Icon icon={icon} size={24}/>
  </span>;
}

function AttachmentDropTitle({className, ...props}: React.ComponentProps<'p'>) {
  return <p data-slot="attachment-drop-title" className={cn('type-label text-text-1 group-data-disabled/attachment-drop:text-text-disabled', className)} {...props}/>;
}

/** What it takes: types and the size limit. */
function AttachmentDropDescription({className, ...props}: React.ComponentProps<'p'>) {
  return <p data-slot="attachment-drop-description" className={cn('type-body-sm text-text-3 data group-data-disabled/attachment-drop:text-text-disabled', className)} {...props}/>;
}

/**
 * The way in without dragging: a secondary button that opens the file picker. A zone sits on paper with its own
 * control line, so the secondary edge reads there and the screen keeps its one primary for the next step.
 */
function AttachmentDropTrigger({variant, size = 'sm', onClick, disabled, ...props}: ButtonProps) {
  const {open, disabled: dropDisabled} = useAttachmentDrop();
  return <Button
    data-slot="attachment-drop-trigger"
    variant={variant ?? 'secondary'}
    size={size}
    disabled={disabled || dropDisabled}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) open(); }}
    {...props}
  />;
}

/** A short reason for a rejection, for a toast, an attachment chip or a status line. */
function rejectionReason({file, reason}: FileRejection, {accept, maxSize}: {accept?: string; maxSize?: number} = {}) {
  if (reason === 'size') return maxSize ? `${formatBytes(file.size)}, over the ${formatBytes(maxSize)} limit` : 'Too large';
  if (reason === 'count') return 'One file at a time';
  const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : file.type;
  return accept ? `${ext || 'This type'} files are not accepted here` : 'This type is not accepted';
}


// ---------- Tile (was Upload preview) ----------

const attachmentTileVariants = cva(
  [
    'group/attachment-tile relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-soft bg-secondary text-text-2 select-none',
    'transition-[background-color,scale,outline-color] duration-(--dur-fast) ease-(--ease-step)',
    'hover:not-data-disabled:bg-button-secondary-hover active:not-data-disabled:scale-(--scale-press) active:duration-(--dur-press)',
    'data-disabled:not-aria-busy:cursor-not-allowed data-disabled:not-aria-busy:text-text-disabled aria-busy:cursor-progress',
    // The image dims to the disabled text alpha, so a disabled slot reads as one with a disabled label.
    'data-disabled:not-aria-busy:*:[img]:opacity-(--dim-opacity)',
    'forced-colors:border forced-colors:border-[ButtonText]',
  ],
  {
    variants: {
      size: {
        sm: 'size-12',
        default: 'size-16',
        lg: 'size-24',
      },
    },
    defaultVariants: {size: 'default'},
  },
);

type AttachmentTileProps = Omit<ButtonPrimitive.Props, 'children'> & VariantProps<typeof attachmentTileVariants> & {
  variant: 'tile';
  /** Says which image this slot sets or replaces: "Change agent avatar". Required: the slot has no text. */
  'aria-label': string;
  /** The current image. Leave out for the empty slot. */
  src?: string;
  /** cover fills the square; contain keeps a logo whole with a 4px inset. */
  fit?: 'cover' | 'contain';
  /** Uploading. Keeps the box and focus, blocks another press. */
  loading?: boolean;
  /** Opens a file picker on press and hands back the chosen file. */
  onFile?: (file: File) => void;
  /** The picker's accept. Images by default. */
  accept?: string;
  /** Overrides the empty-slot glyph or the image, for a custom preview. */
  children?: React.ReactNode;
};

const glyphSize = {sm: 16, default: 20, lg: 24} as const;

function AttachmentTile({
  className, size = 'default', src, fit = 'cover', loading = false, disabled, onFile, accept = 'image/*',
  onClick, children, focusableWhenDisabled, variant: _variant, ...props
}: AttachmentTileProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const showImage = src && failed !== src;
  const glyph = glyphSize[size ?? 'default'];

  return <>
    <ButtonPrimitive
      data-slot="attachment"
      data-variant="tile"
      data-size={size}
      data-state={loading ? 'loading' : showImage ? 'filled' : 'empty'}
      disabled={disabled || loading}
      focusableWhenDisabled={loading || focusableWhenDisabled}
      aria-busy={loading || undefined}
      className={mergeClass(attachmentTileVariants({size}), className)}
      onClick={event => {
        onClick?.(event);
        if (!event.defaultPrevented && onFile) inputRef.current?.click();
      }}
      {...props}
    >
      {children ?? (showImage
        ? <img
            src={src}
            alt=""
            draggable={false}
            onError={() => setFailed(src)}
            className={cn('size-full', fit === 'cover' ? 'object-cover' : 'object-contain p-1')}
          />
        : <Icon icon={Image} size={glyph}/>)}
      {showImage && !loading && <span
        data-slot="attachment-tile-replace"
        aria-hidden
        className={cn(
          'pointer-events-none absolute inset-x-1 bottom-1 flex items-center justify-center gap-1 rounded-inner bg-inverse px-1 py-0.5 type-label-sm text-text-inverse opacity-0 transition-opacity duration-(--dur-fast)',
          // With no hover (a phone) Replace shows at rest, since there is no other way to learn the tile is a button.
          'group-hover/attachment-tile:opacity-100 group-focus-visible/attachment-tile:opacity-100 touch:opacity-100 group-data-disabled/attachment-tile:hidden',
          size === 'sm' && 'inset-x-auto px-0.5',
        )}
      >
        <Icon icon={Renew} size={12}/>
        {size !== 'sm' && 'Replace'}
      </span>}
      {loading && <span data-slot="attachment-tile-loading" className="absolute inset-0 flex items-center justify-center bg-secondary text-text-1">
        <Icon icon={CircleDash} size={glyph} className="animate-spin motion-reduce:animate-none"/>
      </span>}
    </ButtonPrimitive>
    {onFile && <input
      ref={inputRef}
      type="file"
      hidden
      tabIndex={-1}
      aria-hidden
      accept={accept}
      onChange={event => {
        const file = event.currentTarget.files?.[0];
        if (file) onFile(file);
        event.currentTarget.value = '';
      }}
    />}
  </>;
}


export {
  Attachment,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentContent,
  AttachmentTitle,
  AttachmentDescription,
  AttachmentProgress,
  AttachmentActions,
  AttachmentAction,
  AttachmentTrigger,
  AttachmentGlyph,
  AttachmentDrop,
  AttachmentDropIcon,
  AttachmentDropTitle,
  AttachmentDropDescription,
  AttachmentDropTrigger,
  AttachmentTile,
  attachmentVariants,
  attachmentDropVariants,
  attachmentTileVariants,
  fileGlyph,
  formatBytes,
  formatProgress,
  rejectionReason,
  acceptTokens,
  dragVerdict,
  describeAccept,
  useAttachmentDrop,
  type AttachmentProps,
  type AttachmentState,
  type AttachmentDropProps,
  type AttachmentTileProps,
  type FileRejection,
};
