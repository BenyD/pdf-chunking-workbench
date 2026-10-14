'use client';

import * as React from 'react';
import {Icon, Undo, Close} from '@/components/quartz/icon';
import {cn, withDefaults} from '@/lib/quartz/utils';
import {formatBytes} from '@/lib/quartz/format';
import {
  Attachment as AttachmentChip, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGlyph, AttachmentMedia,
  AttachmentProgress, AttachmentTitle, acceptTokens, dragVerdict,
} from '@/components/quartz/ui/attachment';

// One file in the composer, the accept check the paperclip, a paste and a drop share, and the drop itself. The file
// is the Attachment chip, so a file in the composer reads the same as one in a message or a form.

type Attachment = {
  id: string;
  name: string;
  /** Bytes. Shown once the upload is done. */
  size?: number;
  /** 0 to 1 while uploading. */
  progress?: number;
  status: 'uploading' | 'done' | 'error';
  /** Why it failed, read by screen readers and shown in the chip. */
  error?: string;
};

/** Matches a file against an accept string ("image/*,.log,.md"). No accept string takes everything. */
function accepts(file: File, accept?: string) {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(rule =>
    rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? file.type.startsWith(rule.slice(0, -1)) : file.type === rule);
}

/**
 * Files dragged over the composer: `dragging` while a drag that carries files is over it, 'accept' or 'reject'
 * as AttachmentDrop judges it before the drop (by type, when `accept` names no extension), and the handlers for its
 * root. A drag that ends outside the window never sends dragleave, so leaving the window resets it.
 */
function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void, accept?: string) {
  const depth = React.useRef(0);
  const [dragging, setDragging] = React.useState<false | 'accept' | 'reject'>(false);
  React.useEffect(() => {
    if (!dragging) return;
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('blur', reset); };
  }, [dragging]);
  // Disabled mid-drag, the handlers go and no dragleave arrives, so the drag state resets here; otherwise
  // re-enabling would show a drag that ended long ago.
  React.useEffect(() => {
    if (enabled) return;
    depth.current = 0;
    setDragging(false);
  }, [enabled]);
  const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');
  const dropProps = enabled ? {
    onDragEnter: (event: React.DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); depth.current += 1; setDragging(dragVerdict(acceptTokens(accept), event.dataTransfer.items)); },
    onDragOver: (event: React.DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = dragging === 'reject' ? 'none' : 'copy'; },
    onDragLeave: (event: React.DragEvent) => { if (!hasFiles(event)) return; depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false); },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      onFiles(Array.from(event.dataTransfer.files));
    },
  } : {};
  return {dragging: enabled && dragging, dropProps};
}

type PromptAttachmentLabels = {
  /** The line under the name while it uploads, from the whole percent. */
  uploading?: (percent: number) => string;
  /** The failure when the attachment has no error of its own. */
  uploadFailed?: string;
  /** The line under a finished file whose size is unknown. */
  attached?: string;
  /** The names of the Retry, Cancel and Remove buttons, from the file's name. */
  retryFile?: (name: string) => string;
  cancelUpload?: (name: string) => string;
  removeFile?: (name: string) => string;
};

const attachmentLabels: Required<PromptAttachmentLabels> = {
  uploading: percent => `Uploading ${percent}%`,
  uploadFailed: 'Upload failed',
  attached: 'Attached',
  retryFile: name => `Retry ${name}`,
  cancelUpload: name => `Cancel upload of ${name}`,
  removeFile: name => `Remove ${name}`,
};

type PromptAttachmentProps = Omit<React.ComponentProps<'div'>, 'children'> & {
  attachment: Attachment;
  /** Removes a finished file, or cancels one still uploading. */
  onRemove?: () => void;
  /** Shown on a failed upload. */
  onRetry?: () => void;
  /** The status words and button names, for another language. */
  labels?: PromptAttachmentLabels;
};

/** One file in the composer: the Attachment chip with its glyph, name, then its size, its progress, or its failure with Retry. */
function PromptAttachment({attachment, onRemove, onRetry, labels, className, ...props}: PromptAttachmentProps) {
  const words = withDefaults(attachmentLabels, labels);
  const {name, size, progress = 0, status, error} = attachment;
  const percent = Math.round(Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0)) * 100);
  return <AttachmentChip
    data-slot="prompt-attachment"
    state={status}
    title={name}
    className={cn('max-w-(--attachment-max)', className)}
    {...props}
  >
    <AttachmentMedia><AttachmentGlyph type="" name={name}/></AttachmentMedia>
    <AttachmentContent>
      <AttachmentTitle>{name}</AttachmentTitle>
      <AttachmentDescription>
        {status === 'uploading' ? words.uploading(percent) : status === 'error' ? (error ?? words.uploadFailed) : size !== undefined ? formatBytes(size) : words.attached}
      </AttachmentDescription>
    </AttachmentContent>
    {(onRemove || (status === 'error' && onRetry)) && <AttachmentActions>
      {status === 'error' && onRetry && <AttachmentAction aria-label={words.retryFile(name)} onClick={onRetry}><Icon icon={Undo} size={16}/></AttachmentAction>}
      {onRemove && <AttachmentAction aria-label={status === 'uploading' ? words.cancelUpload(name) : words.removeFile(name)} onClick={onRemove}><Icon icon={Close} size={16}/></AttachmentAction>}
    </AttachmentActions>}
    {status === 'uploading' && <AttachmentProgress value={percent} label={name} aria-hidden/>}
  </AttachmentChip>;
}

export {PromptAttachment, accepts, useFileDrop, type Attachment, type PromptAttachmentProps, type PromptAttachmentLabels};
