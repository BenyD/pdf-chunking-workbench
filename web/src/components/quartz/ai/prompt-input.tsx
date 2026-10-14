'use client';

import * as React from 'react';
import {Icon, Search, Add, Terminal, ChevronDown} from '@/components/quartz/icon';
import {Button, type ButtonProps} from '@/components/quartz/ui/button';
import {formatCount} from '@/lib/quartz/format';
import {cn, withDefaults} from '@/lib/quartz/utils';
import {Mention, encodeMentionId, mentionTypeLabels, parseMentions, uniqueLabel, type MentionType} from '@/components/quartz/ai/mention';
import {SendButton, type SendButtonLabels, type SendStatus} from '@/components/quartz/ai/send-button';
import {CODEC_TYPE, DRAFT_PREFIX, PASTE_CHARS, PASTE_LINES, isComposing, lineCount, serialize, type PromptMention, type PromptMode, type PromptValue} from '@/components/quartz/ai/prompt-input/codec';
import {describeAccept} from '@/components/quartz/ui/attachment';
import {PromptAttachment, accepts, useFileDrop, type Attachment, type PromptAttachmentLabels, type PromptAttachmentProps} from '@/components/quartz/ai/prompt-input/attachment';
import {PromptInputMic, type MicState, type PromptInputMicLabels, type PromptInputMicProps} from '@/components/quartz/ai/prompt-input/mic';
import {TriggerMenu, matchRank, type MenuOption, type MenuState} from '@/components/quartz/ai/prompt-input/menu';
import {caretAt, caretAtEnd, chipAtCaret} from '@/components/quartz/ai/prompt-input/caret';
import {PromptQueue, type PromptQueueLabels, type PromptQueueProps, type QueuedMessage} from '@/components/quartz/ai/prompt-queue';

// The composer's editor: where a person writes the next turn for an agent.
//
// The considered detail: a chip is one thing. A mention, a command or a collapsed paste is a single
// atomic unit in the text. One Backspace removes the whole chip, and Undo (Mod+Z, or the Undo the status
// line offers) puts it back where it was. ArrowLeft and ArrowRight hop over it in one press. Copying writes
// it as `[label](type:id)`, so it survives any clipboard and comes back a chip when pasted into a composer.
//
// - Enter sends, Shift+Enter breaks the line, and nothing fires while an IME is composing (isComposing or
//   keyCode 229, which WebKit sends after compositionend).
// - `@` after a space or at the start of a line opens files and resources. `/` as the whole input opens
//   commands inline; `/` typed at the start of a draft opens a searchable command menu over the draft, so
//   the draft is kept and the command is put in front of it. `!` at the start of an empty prompt enters
//   shell mode: mono, no spellcheck, a $ in front, sent with mode "shell". Backspace on empty leaves it.
// - Escape does one thing, in this order: close the menu, leave shell mode, cancel a held send, stop the
//   run, blur. When it does one of the first four it stops there, so a parent dialog stays open.
// - A paste of 3 or more lines or 150 or more characters collapses into a "Pasted 12 lines" chip. It is
//   sent in full; clicking the chip expands it back into the text, and Mod+Z or Undo collapses it again.
// - Drafts persist per `draftKey` in local storage, saved 200ms after the last edit and cleared on send.
// - Send waits for uploads. Enter while files upload holds the send: the status line says it sends when
//   they finish, with Cancel, and it fires once the last one is done. A failed upload blocks the send
//   until it is removed or retried, so a file the person attached is never dropped without a word.
// - While the agent works, Send is Stop. Enter with text still sends, so the product can queue it; Enter on
//   an empty prompt sends the queue's head now; ArrowUp on an empty prompt edits the queue's tail.
//
// It is a contenteditable editor rather than a textarea because chips must be atomic. It is uncontrolled:
// read it through onValueChange and onSubmit, and drive it through the ref. Its parts live in prompt-input/
// and are all exported from here: the text forms (codec), the caret around chips (caret), the @ and / list
// (menu), a file and the drop (attachment) and the voice action in the toolbar (mic). The stack of
// follow-ups above the composer (prompt-queue) sits beside it.

type MentionItem = {id: string; type: Exclude<MentionType, 'command' | 'paste'>; label: string; detail?: string};
type CommandItem = {id: string; label: string; description?: string};

type PromptInputHandle = {
  focus: () => void;
  clear: () => void;
  /** Puts text at the caret; [label](type:id) tokens become chips. */
  insert: (text: string) => void;
  getValue: () => PromptValue;
};

// ---------- The composer ----------

/** Every word the composer says, for another language. It also takes Send's, a file's and its own. */
type PromptInputLabels = SendButtonLabels & PromptAttachmentLabels & {
  /** Added to the editor's name in shell mode: "Prompt, shell command". */
  shell?: string;
  /** The placeholder while disabled, and in shell mode. */
  off?: string;
  shellPlaceholder?: string;
  /** The status line in shell mode. */
  shellStatus?: string;
  /** The paperclip's name, the file row's name and the drop overlay. */
  attach?: string;
  attachments?: string;
  drop?: string;
  undo?: string;
  /** Cancels a send held for uploads. */
  cancel?: string;
  /** The names of the @ list, the / list and the command search. */
  files?: string;
  commands?: string;
  searchCommands?: string;
  noMatches?: (query: string) => string;
  /** Read out as the list filters. */
  results?: (count: number) => string;
  /** The type word for a chip's name and a menu row: "File", "Run". */
  types?: Partial<Record<MentionType, string>>;
  /** Why Send waits or is blocked. */
  waiting?: (uploads: number) => string;
  held?: (uploads: number) => string;
  failed?: (names: string[]) => string;
  notSent?: (reason: string) => string;
  /** What the status line says after an edit it can undo, from the chip's label. */
  removed?: (label: string) => string;
  expanded?: (label: string) => string;
  /** A collapsed paste's chip, and its tooltip's last line. */
  pasted?: (lines: number, characters: number) => string;
  clickToExpand?: string;
  textOnly?: string;
  /** The drop overlay's words when a file type is refused, from the accepted types: "Only images can be attached here". */
  acceptOnly?: (types: string) => string;
  notAttached?: (names: string[], accept: string | undefined) => string;
  tooLong?: (characters: number, fit: number) => string;
  /** The status line while calls in the thread wait on the person, and its link to the first one. */
  waitingOnYou?: (calls: number) => string;
  review?: string;
};

const promptLabels: Required<Omit<PromptInputLabels, keyof SendButtonLabels | keyof PromptAttachmentLabels>> = {
  shell: 'shell command',
  off: 'Composer is off',
  shellPlaceholder: 'Run a shell command',
  shellStatus: 'Shell. Escape to leave',
  attach: 'Attach files',
  attachments: 'Attachments',
  drop: 'Drop to attach',
  undo: 'Undo',
  cancel: 'Cancel',
  files: 'Files and resources',
  commands: 'Commands',
  searchCommands: 'Search commands',
  noMatches: query => `No matches for “${query}”`,
  results: n => `${n} ${n === 1 ? 'result' : 'results'}`,
  types: mentionTypeLabels,
  waiting: n => `Waiting for ${n} ${n === 1 ? 'upload' : 'uploads'}`,
  held: n => `Waiting for ${n} ${n === 1 ? 'upload' : 'uploads'}. Sends when they finish`,
  failed: names => (names.length === 1 ? `${names[0]} failed. Remove or retry it` : `${names.length} files failed. Remove or retry them`),
  notSent: reason => `${reason}. Not sent.`,
  removed: label => `Removed ${label}`,
  expanded: label => `Expanded ${label.replace(/^Pasted /, 'the paste of ')}`,
  pasted: (lines, characters) => (lines >= PASTE_LINES ? `Pasted ${lines} lines` : `Pasted ${formatCount(characters)} characters`),
  clickToExpand: 'Click to expand',
  textOnly: 'This prompt takes text only',
  acceptOnly: types => `Only ${types} can be attached here`,
  notAttached: (names, accept) => `Not attached: ${names.join(', ')}.${accept ? ` Accepts ${accept}` : ''}`,
  tooLong: (characters, fit) => `Too long to paste: ${formatCount(characters)} characters, ${formatCount(fit)} fit. Attach it as a file.`,
  waitingOnYou: n => `${n} ${n === 1 ? 'call' : 'calls'} waiting on you`,
  review: 'Review',
};

type PromptInputProps = Omit<React.ComponentProps<'div'>, 'onSubmit' | 'children' | 'defaultValue' | 'ref'> & {
  onSubmit?: (value: PromptValue, attachments: Attachment[]) => void;
  onValueChange?: (value: PromptValue) => void;
  /** Starting text. [label](type:id) tokens become chips. A saved draft wins over it. */
  defaultValue?: string;
  /** Persists the draft in local storage under this key, 200ms after the last edit. Cleared on send. */
  draftKey?: string;
  placeholder?: string;
  /** inline is one 44px row that grows upward as the text wraps; stacked is the text on top of a toolbar row, for long-form. */
  layout?: 'inline' | 'stacked';
  /** The send button's state. submitted and streaming turn it into Stop. */
  status?: SendStatus;
  /** Called once per generation, from the Stop button or Escape, with the generation it stops. Settle only
   *  that run: a stop echo for an older generation must not touch a newer one. */
  onStop?: (generation: string | number | undefined) => void;
  /** The run Stop applies to. A new one re-arms Stop. */
  generation?: string | number;
  /** No input at all, for example out of credits. Say why in disabledReason. */
  disabled?: boolean;
  disabledReason?: React.ReactNode;
  /** An action next to the reason: "See plans". */
  disabledAction?: React.ReactNode;
  /** What @ offers. */
  mentions?: MentionItem[];
  /** What / offers. */
  commands?: CommandItem[];
  /** Turns on `!` shell mode. */
  shell?: boolean;
  /** Controls shell mode. */
  mode?: PromptMode;
  onModeChange?: (mode: PromptMode) => void;
  attachments?: Attachment[];
  /** Files from the paperclip, a paste or a drop, already checked against `accept`. Leave out to hide the paperclip. */
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  /** Passed to the file picker and checked on paste and drop: "image/*,.log,.md". */
  accept?: string;
  /** The longest prompt, in characters. A paste past it is refused with a reason. */
  maxLength?: number;
  /** Voice input in the toolbar. */
  voice?: Omit<PromptInputMicProps, 'size'>;
  /** The model picker and its mode preset: the toolbar's left side when stacked, a quiet chip before Send when inline. */
  tools?: React.ReactNode;
  /** Before the send button: the context meter. */
  meta?: React.ReactNode;
  /** ArrowUp on an empty prompt: edit the queue's last message. Return false when there is none. */
  onEditQueued?: () => boolean;
  /** Enter on an empty prompt while the agent works: send the queue's head now. */
  onSendQueuedNow?: () => void;
  /** Calls in the thread waiting on the person. The status line says so in ink, with a link to the first. */
  waitingCount?: number;
  /** The status line's Review link: focus the waiting row's Allow. */
  onReviewWaiting?: () => void;
  /** Names the editor for assistive tech. */
  label?: string;
  /** The composer's other words, for another language. The placeholder and `label` are their own props. */
  labels?: PromptInputLabels;
  ref?: React.Ref<PromptInputHandle>;
};

type Notice = {id: number; text: string; undo?: () => void};

function PromptInput({
  ref, onSubmit, onValueChange, defaultValue, draftKey, placeholder = 'Ask the agent to do something', layout = 'inline', status = 'ready', onStop, generation,
  disabled, disabledReason, disabledAction, mentions = [], commands = [], shell = false, mode: modeProp, onModeChange,
  attachments = [], onAttach, onRemoveAttachment, onRetryAttachment, accept, maxLength = 100_000, voice, tools, meta,
  onEditQueued, onSendQueuedNow, waitingCount = 0, onReviewWaiting, label = 'Prompt', labels, className, ...props
}: PromptInputProps) {
  const words = {...withDefaults(promptLabels, labels), types: withDefaults(mentionTypeLabels, labels?.types)};
  // Chips are made in callbacks that outlive a render; they read the words through a ref.
  const wordsRef = React.useRef(words);
  wordsRef.current = words;
  const editorRef = React.useRef<HTMLDivElement>(null);
  const templatesRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const pastes = React.useRef(new Map<string, string>());
  const composing = React.useRef(false);
  const dismissed = React.useRef<{node: Text | null; start: number} | null>(null);
  const version = React.useRef(0);
  const undoStack = React.useRef<{version: number; restore: () => void}[]>([]);
  const savedRange = React.useRef<Range | null>(null);
  const draftTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopFor = React.useRef<string | number | null>(null);
  const [empty, setEmpty] = React.useState(true);
  const [focused, setFocused] = React.useState(false);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [active, setActive] = React.useState(0);
  const [innerMode, setInnerMode] = React.useState<PromptMode>('normal');
  const [stopping, setStopping] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  // Enter while files upload: the send waits and fires when the last one finishes.
  const [held, setHeld] = React.useState(false);
  const menuId = React.useId();
  const reasonId = React.useId();
  const statusId = React.useId();

  const mode = modeProp ?? innerMode;
  // The debounced and unmount saves and read() run outside a render, so they read the mode from here.
  // setMode writes it at once: a draft restored in shell mode on mount is saved as shell, not as the
  // mode the save's closure saw before the re-render.
  const modeRef = React.useRef(mode);
  modeRef.current = mode;
  const setMode = (next: PromptMode) => { modeRef.current = next; if (modeProp === undefined) setInnerMode(next); onModeChange?.(next); };
  const uploading = attachments.filter(a => a.status === 'uploading').length;
  const working = status === 'submitted' || status === 'streaming' || status === 'stopping';
  const uploadReason = uploading ? words.waiting(uploading) : undefined;
  const failedFiles = attachments.filter(a => a.status === 'error');
  const failedReason = failedFiles.length ? words.failed(failedFiles.map(f => f.name)) : undefined;
  const blockReason = uploadReason ?? failedReason;

  // Removing or retrying a file takes away the button that had focus. Focus goes to the same place in the
  // row of files, or back to the editor when none is left, so a keyboard user can clear a row of files.
  const attachRef = React.useRef<HTMLDivElement>(null);
  const attachIndex = React.useRef<number | null>(null);
  React.useLayoutEffect(() => {
    const index = attachIndex.current;
    if (index === null) return;
    attachIndex.current = null;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.isConnected && !active.matches(':disabled')) return;
    const items = attachRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [];
    const buttons = items[Math.min(index, items.length - 1)]?.querySelectorAll<HTMLElement>('button:not(:disabled)');
    const target = buttons?.length ? buttons[buttons.length - 1] : editorRef.current;
    target?.focus();
  }, [attachments]);

  React.useEffect(() => { if (!working) { stopFor.current = null; setStopping(false); } }, [working]);
  React.useEffect(() => { stopFor.current = null; setStopping(false); }, [generation]);

  const say = React.useCallback((text: string, undo?: () => void) => setNotice({id: Date.now(), text, undo}), []);
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(n => (n?.id === notice.id ? null : n)), notice.undo ? 6000 : 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // ----- chips -----
  const makeChip = React.useCallback((mention: PromptMention) => {
    const template = templatesRef.current?.querySelector<HTMLElement>(`[data-template="${mention.type}"]`);
    const chip = (template?.cloneNode(true) as HTMLElement | undefined) ?? document.createElement('span');
    chip.removeAttribute('data-template');
    chip.removeAttribute('hidden');
    chip.contentEditable = 'false';
    chip.dataset.mentionId = mention.id;
    chip.dataset.mentionType = mention.type;
    chip.dataset.mentionLabel = mention.label;
    chip.setAttribute('aria-label', `${wordsRef.current.types[mention.type]} ${mention.label}`);
    if (mention.type === 'paste') chip.title = `${(pastes.current.get(mention.id) ?? '').slice(0, 280)}\n\n${wordsRef.current.clickToExpand}`;
    const text = chip.querySelector('[data-slot="mention-label"]') ?? chip;
    text.textContent = `${mention.type === 'command' ? '/' : ''}${mention.label}`;
    return chip;
  }, []);

  const fragmentFrom = React.useCallback((source: string) => {
    const fragment = document.createDocumentFragment();
    for (const token of parseMentions(source)) {
      if (token.kind === 'text') fragment.append(document.createTextNode(token.text));
      else if (token.mention.type !== 'paste' || pastes.current.has(token.mention.id)) fragment.append(makeChip(token.mention));
    }
    return fragment;
  }, [makeChip]);

  const read = React.useCallback((): PromptValue & {codec: string} => {
    const {text, serialized, codec, mentions: list} = serialize(editorRef.current ?? document.createElement('div'), pastes.current);
    return {text: text.replace(/\s+$/, ''), serialized: serialized.replace(/\s+$/, ''), codec, mentions: list, mode: modeRef.current};
  }, []);

  const saveDraft = React.useCallback((codec: string) => {
    if (!draftKey) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      draftTimer.current = null;
      try {
        const key = DRAFT_PREFIX + draftKey;
        if (!codec.trim()) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify({codec, mode: modeRef.current, pastes: [...pastes.current]}));
      } catch {}
    }, 200);
  }, [draftKey]);

  const changed = React.useCallback(() => {
    version.current += 1;
    // An edit makes any offered Undo stale; Mod+Z refuses it, so the link goes too.
    setNotice(n => (n?.undo ? null : n));
    const value = read();
    setEmpty(!value.text.trim() && value.mentions.length === 0);
    saveDraft(value.codec);
    const {codec: _codec, ...out} = value;
    onValueChange?.(out);
  }, [read, onValueChange, saveDraft]);

  /** Puts a fragment at the caret (or the end), replacing the selection, and leaves the caret after it. */
  const insertFragment = React.useCallback((fragment: DocumentFragment) => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = window.getSelection();
    let range: Range;
    if (selection?.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) range = selection.getRangeAt(0);
    else if (savedRange.current && editor.contains(savedRange.current.commonAncestorContainer)) range = savedRange.current;
    else { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
    const lastNode = fragment.lastChild;
    range.deleteContents();
    range.insertNode(fragment);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    changed();
  }, [changed]);

  const clear = React.useCallback(() => {
    editorRef.current?.replaceChildren();
    pastes.current.clear();
    undoStack.current = [];
    setMenu(null);
    if (draftTimer.current) { clearTimeout(draftTimer.current); draftTimer.current = null; }
    try { if (draftKey) localStorage.removeItem(DRAFT_PREFIX + draftKey); } catch {}
    version.current += 1;
    setEmpty(true);
    setHeld(false);
    onValueChange?.({text: '', serialized: '', mentions: [], mode});
  }, [draftKey, mode, onValueChange]);

  React.useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    clear,
    insert: (text: string) => { editorRef.current?.focus(); insertFragment(fragmentFrom(text)); },
    getValue: () => { const {codec: _codec, ...value} = read(); return value; },
  }), [clear, fragmentFrom, insertFragment, read]);

  // Starting text: the saved draft first, then defaultValue. Once, after the chip templates exist.
  React.useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    let source = defaultValue;
    try {
      const saved = draftKey ? localStorage.getItem(DRAFT_PREFIX + draftKey) : null;
      if (saved) {
        const draft = JSON.parse(saved) as {codec?: string; mode?: PromptMode; pastes?: [string, string][]};
        if (typeof draft.codec === 'string') source = draft.codec;
        for (const [k, v] of draft.pastes ?? []) pastes.current.set(k, v);
        if (draft.mode === 'shell' && shell) setMode('shell');
      }
    } catch {
      try { if (draftKey) localStorage.removeItem(DRAFT_PREFIX + draftKey); } catch {}
    }
    if (!source) return;
    editor.replaceChildren(fragmentFrom(source));
    changed();
    // Mount only: a later defaultValue never overwrites what the person typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pending draft save still lands if the composer unmounts inside the 200ms window.
  React.useEffect(() => () => {
    if (!draftTimer.current || !draftKey || !editorRef.current) return;
    clearTimeout(draftTimer.current);
    try {
      const {codec} = serialize(editorRef.current, pastes.current);
      if (codec.trim()) localStorage.setItem(DRAFT_PREFIX + draftKey, JSON.stringify({codec, mode: modeRef.current, pastes: [...pastes.current]}));
    } catch {}
  }, [draftKey]);

  const removeChip = (chip: HTMLElement) => {
    const parent = chip.parentNode;
    const next = chip.nextSibling;
    if (!parent) return;
    const name = chip.dataset.mentionLabel ?? 'chip';
    // Close the double space a removed chip leaves.
    const before = chip.previousSibling;
    const after = chip.nextSibling;
    let trimmed: {node: Text; text: string} | null = null;
    if (before instanceof Text && after instanceof Text && before.data.endsWith(' ') && after.data.startsWith(' ')) {
      trimmed = {node: after, text: after.data};
      after.data = after.data.slice(1);
    }
    chip.remove();
    if (next && next.parentNode === parent) caretAt('before', next);
    else caretAtEnd(parent);
    changed();
    const at = version.current;
    const restore = () => {
      if (trimmed) trimmed.node.data = trimmed.text;
      if (next && next.parentNode === parent) parent.insertBefore(chip, next); else parent.appendChild(chip);
      caretAt('after', chip);
      changed();
      setNotice(null);
    };
    undoStack.current.push({version: at, restore});
    say(words.removed(name), restore);
  };

  const undoChip = () => {
    const top = undoStack.current.at(-1);
    if (!top || top.version !== version.current) { undoStack.current = []; return false; }
    undoStack.current.pop();
    top.restore();
    return true;
  };

  // ----- menus -----
  const options: MenuOption[] = React.useMemo(() => {
    if (!menu) return [];
    const q = menu.query.toLowerCase();
    const rank = (label: string) => matchRank(label, q);
    if (menu.kind === '@') {
      return mentions.filter(m => m.label.toLowerCase().includes(q)).sort((a, b) => rank(a.label) - rank(b.label)).slice(0, 8)
        .map(m => ({key: `${m.type}:${m.id}`, mention: {id: m.id, type: m.type, label: m.label}, detail: m.detail}));
    }
    return commands.filter(c => c.label.toLowerCase().includes(q)).sort((a, b) => rank(a.label) - rank(b.label)).slice(0, 8)
      .map(c => ({key: `command:${c.id}`, mention: {id: c.id, type: 'command' as const, label: c.label}, description: c.description}));
  }, [menu, mentions, commands]);

  const detectTrigger = React.useCallback(() => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (composing.current) return;
    setMenu(prev => {
      if (prev?.kind === 'commands') return prev;
      if (!editor || !selection?.rangeCount || !selection.isCollapsed || mode === 'shell') return null;
      const node = selection.anchorNode;
      if (!(node instanceof Text) || !editor.contains(node)) return null;
      const before = node.data.slice(0, selection.anchorOffset);
      const match = before.match(/(?:^|[\s ])([@/])([^\s@/]{0,40})$/);
      const trigger = match?.[1] as '@' | '/' | undefined;
      if (!match || !trigger) return null;
      if (trigger === '@' && !mentions.length) return null;
      if (trigger === '/') {
        // Only as the whole input: "/dep" with nothing else in the prompt.
        const whole = serialize(editor, pastes.current).codec.trim();
        if (!commands.length || !/^\/[^\s@/]*$/.test(whole)) return null;
      }
      const start = before.length - match[2].length - 1;
      if (dismissed.current?.node === node && dismissed.current.start === start) return null;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      let rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) rect = editor.getBoundingClientRect();
      if (!prev || prev.node !== node || prev.start !== start || prev.kind !== trigger) setActive(0);
      return {kind: trigger, query: match[2], node, start, rect};
    });
  }, [mentions.length, commands.length, mode]);

  const openCommandMenu = () => {
    const editor = editorRef.current;
    if (!editor || !commands.length) return;
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) savedRange.current = selection.getRangeAt(0).cloneRange();
    setActive(0);
    setMenu({kind: 'commands', query: '', node: null, start: 0, rect: editor.getBoundingClientRect()});
    requestAnimationFrame(() => searchRef.current?.focus());
  };

  const closeMenu = (refocus = false) => {
    if (menu?.node) dismissed.current = {node: menu.node, start: menu.start};
    const wasCommands = menu?.kind === 'commands';
    setMenu(null);
    if (refocus || wasCommands) {
      editorRef.current?.focus();
      if (savedRange.current) { window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(savedRange.current); }
    }
  };

  const pick = (option: MenuOption) => {
    const editor = editorRef.current;
    if (!menu || !editor) return;
    const taken = serialize(editor, pastes.current).mentions;
    const mention = {...option.mention, label: option.mention.type === 'command' ? option.mention.label : uniqueLabel(option.mention, taken)};
    const chip = makeChip(mention);
    const space = document.createTextNode(' ');
    if (menu.kind === 'commands') {
      // Over a draft: the command goes in front of what is already written.
      editor.prepend(chip, space);
      setMenu(null);
      editor.focus();
      caretAtEnd(editor);
      savedRange.current = null;
      changed();
      return;
    }
    const selection = window.getSelection();
    if (!menu.node || !selection) return;
    const range = document.createRange();
    range.setStart(menu.node, menu.start);
    range.setEnd(menu.node, Math.min(menu.node.length, selection.anchorNode === menu.node ? selection.anchorOffset : menu.start + 1 + menu.query.length));
    range.deleteContents();
    range.insertNode(space);
    range.insertNode(chip);
    range.setStart(space, 1);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    setMenu(null);
    changed();
  };

  // The menu follows the caret when the page or the editor scrolls.
  const open = !!menu;
  React.useEffect(() => {
    if (!open) return;
    const follow = () => {
      if (menu?.kind === 'commands') { const r = editorRef.current?.getBoundingClientRect(); if (r) setMenu(m => (m ? {...m, rect: r} : m)); }
      else detectTrigger();
    };
    window.addEventListener('resize', follow);
    window.addEventListener('scroll', follow, true);
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true); };
  }, [open, menu?.kind, detectTrigger]);

  // ----- sending and stopping -----
  const hasDone = attachments.some(a => a.status === 'done');
  const canSend = !disabled && !uploading && !failedFiles.length && (!empty || hasDone);
  const send = () => {
    if (disabled) return;
    if (failedFiles.length) { say(words.notSent(failedReason!)); return; }
    if (uploading) { if (!empty || hasDone) setHeld(true); return; }
    if (!canSend) return;
    const {codec: _codec, ...value} = read();
    onSubmit?.(value, attachments.filter(a => a.status === 'done'));
    clear();
    if (mode === 'shell') setMode('normal');
  };
  // The held send fires when the last upload finishes. A failure on the way cancels it and says which file.
  React.useEffect(() => {
    if (!held) return;
    if (disabled) { setHeld(false); return; }
    if (failedFiles.length) { setHeld(false); say(words.notSent(failedReason!)); return; }
    if (uploading) return;
    setHeld(false);
    send();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const stop = () => {
    const key = generation ?? 'current';
    if (stopFor.current === key) return;
    stopFor.current = key;
    setStopping(true);
    onStop?.(generation);
  };
  /** Escape was used up here: keep it from reaching a parent dialog's document listener. */
  const consume = (event: React.KeyboardEvent) => { event.preventDefault(); event.stopPropagation(); event.nativeEvent.stopImmediatePropagation(); };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event)) return;
    if (menu && menu.kind !== 'commands') {
      const count = options.length;
      const down = event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n');
      const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p');
      if (down && count) { event.preventDefault(); setActive(i => (i + 1) % count); return; }
      if (up && count) { event.preventDefault(); setActive(i => (i - 1 + count) % count); return; }
      if ((event.key === 'Enter' || event.key === 'Tab') && count) { event.preventDefault(); pick(options[Math.min(active, count - 1)]); return; }
      if (event.key === 'Escape') { consume(event); closeMenu(); return; }
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
      if (undoChip()) { event.preventDefault(); return; }
    }
    if (event.key === 'Escape') {
      if (mode === 'shell') { consume(event); setMode('normal'); return; }
      if (held) { consume(event); setHeld(false); return; }
      if (working) { consume(event); stop(); return; }
      // Nothing left to undo here: blur, and let Escape go on to a parent dialog.
      event.preventDefault();
      editorRef.current?.blur();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (event.repeat) return;
      if (empty && !hasDone && working && onSendQueuedNow) { onSendQueuedNow(); return; }
      send();
      return;
    }
    if (event.key === 'Enter' && event.shiftKey) {
      event.preventDefault();
      if (!document.execCommand('insertLineBreak')) insertFragment(fragmentFrom('\n'));
      return;
    }
    if (event.key === 'ArrowUp' && empty && !attachments.length && onEditQueued && !event.altKey && !event.metaKey) {
      if (onEditQueued()) { event.preventDefault(); return; }
    }
    if (event.key === 'Backspace' && !event.metaKey && !event.altKey) {
      if (empty && mode === 'shell') { event.preventDefault(); setMode('normal'); return; }
      const chip = chipAtCaret(editorRef.current, 'back');
      if (chip) { event.preventDefault(); removeChip(chip); return; }
    }
    if (event.key === 'Delete') {
      const chip = chipAtCaret(editorRef.current, 'forward');
      if (chip) { event.preventDefault(); removeChip(chip); return; }
    }
    if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.shiftKey && !event.altKey && !event.metaKey) {
      const rtl = getComputedStyle(editorRef.current!).direction === 'rtl';
      const back = (event.key === 'ArrowLeft') !== rtl;
      const chip = chipAtCaret(editorRef.current, back ? 'back' : 'forward');
      if (chip) { event.preventDefault(); caretAt(back ? 'before' : 'after', chip); return; }
    }
    if (event.key === '!' && shell && mode === 'normal' && empty) { event.preventDefault(); setMode('shell'); return; }
    if (event.key === '/' && !empty && commands.length && mode === 'normal') {
      const selection = window.getSelection();
      const editor = editorRef.current;
      if (selection?.rangeCount && editor) {
        const range = document.createRange();
        range.setStart(editor, 0);
        range.setEnd(selection.anchorNode!, selection.anchorOffset);
        if (!range.toString().trim() && !range.cloneContents().querySelector('[data-mention-id]')) { event.preventDefault(); openCommandMenu(); }
      }
    }
  };

  const onCopy = (event: React.ClipboardEvent<HTMLDivElement>, cut = false) => {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const holder = document.createElement('div');
    holder.append(range.cloneContents());
    const {serialized, codec} = serialize(holder, pastes.current);
    const usedPastes = [...pastes.current].filter(([id]) => codec.includes(`(paste:${encodeMentionId(id)})`));
    event.preventDefault();
    event.clipboardData.setData('text/plain', serialized);
    event.clipboardData.setData(CODEC_TYPE, JSON.stringify({codec, pastes: usedPastes}));
    if (cut) { range.deleteContents(); changed(); }
  };

  const takeFiles = (files: File[]) => {
    if (!files.length) return;
    if (!onAttach) { say(words.textOnly); return; }
    const ok = files.filter(f => accepts(f, accept));
    const refused = files.filter(f => !accepts(f, accept));
    if (refused.length) say(words.notAttached(refused.map(f => f.name), accept));
    if (ok.length) onAttach(ok);
  };

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.clipboardData.files);
    // Mixed paste (a spreadsheet copy carries an image and text): attach the files and keep the text too.
    takeFiles(files);
    const codecData = event.clipboardData.getData(CODEC_TYPE);
    if (codecData) {
      try {
        const {codec, pastes: carried} = JSON.parse(codecData) as {codec: string; pastes?: [string, string][]};
        for (const [k, v] of carried ?? []) pastes.current.set(k, v);
        insertFragment(fragmentFrom(codec));
        return;
      } catch {}
    }
    const text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
    if (!text) return;
    const current = read().text.length;
    if (current + text.length > maxLength) {
      say(words.tooLong(text.length, Math.max(0, maxLength - current)));
      return;
    }
    if (mode !== 'shell' && (lineCount(text) >= PASTE_LINES || text.length >= PASTE_CHARS) && !parseMentions(text).some(t => t.kind === 'mention')) {
      const id = `p${Date.now().toString(36)}${pastes.current.size}`;
      pastes.current.set(id, text);
      const fragment = document.createDocumentFragment();
      fragment.append(makeChip({id, type: 'paste', label: words.pasted(lineCount(text), text.length)}), document.createTextNode(' '));
      insertFragment(fragment);
      return;
    }
    if (parseMentions(text).some(t => t.kind === 'mention')) { insertFragment(fragmentFrom(text)); return; }
    if (!document.execCommand('insertText', false, text)) { const fragment = document.createDocumentFragment(); fragment.append(text); insertFragment(fragment); }
  };

  /** A click on a paste chip expands it back into text. Mod+Z or the Undo link collapses it again. */
  const onEditorClick = (event: React.MouseEvent) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('[data-mention-type="paste"]');
    if (chip && editorRef.current?.contains(chip)) {
      const body = pastes.current.get(chip.dataset.mentionId ?? '') ?? '';
      const node = document.createTextNode(body);
      chip.replaceWith(node);
      caretAt('after', node);
      changed();
      const restore = () => {
        if (!node.parentNode) return;
        node.replaceWith(chip);
        caretAt('after', chip);
        changed();
        setNotice(null);
      };
      undoStack.current.push({version: version.current, restore});
      say(words.expanded(chip.dataset.mentionLabel ?? ''), restore);
      return;
    }
    detectTrigger();
  };

  // ----- dropping files -----
  // The drop is judged while the drag is over the composer: a type accept refuses turns the overlay to the fail wash.
  const {dragging, dropProps} = useFileDrop(!!onAttach && !disabled, files => takeFiles(files), accept);

  const state = disabled ? 'disabled' : mode === 'shell' ? 'shell' : working ? 'working' : uploading ? 'uploading' : failedFiles.length ? 'blocked' : empty ? 'empty' : 'typing';
  const waitingLine = waitingCount > 0 ? words.waitingOnYou(waitingCount) : undefined;
  const statusLine = notice?.text ?? (mode === 'shell' ? words.shellStatus : held && uploading ? words.held(uploading) : blockReason ?? waitingLine);
  const showsWaiting = !!waitingLine && statusLine === waitingLine;
  const sendStatus: SendStatus = working && stopping ? 'stopping' : status;

  const inline = layout === 'inline';
  const shellWell = mode === 'shell' && 'well';
  const attachEl = onAttach && <>
    <Button size="icon-sm" variant="ghost" aria-label={words.attach} disabled={disabled} onClick={() => fileRef.current?.click()}>
      <Icon icon={Add} size={16}/>
    </Button>
    <input ref={fileRef} type="file" multiple hidden accept={accept} tabIndex={-1} onChange={event => {
      takeFiles(Array.from(event.target.files ?? []));
      event.target.value = '';
    }}/>
  </>;
  const statusEl = <p id={statusId} role="status" data-slot="prompt-input-status" className={cn(
    inline
      ? 'flex min-w-0 flex-1 items-center gap-1.5 type-label-sm text-text-2 empty:hidden'
      : 'order-last flex min-w-0 shrink basis-full items-center gap-1.5 px-2 type-label-sm text-text-2 empty:hidden @sm/prompt-toolbar:order-none @sm/prompt-toolbar:basis-auto',
    !statusLine && 'hidden', showsWaiting && 'text-text-1', !!failedReason && statusLine === failedReason && 'text-fail-text',
  )}>
    {mode === 'shell' && !notice && <Icon icon={Terminal} size={12} className="shrink-0"/>}
    {statusLine && <span className="min-w-0 truncate" title={statusLine}>{statusLine}</span>}
    {showsWaiting && onReviewWaiting && <Button variant="link" size="xs" data-slot="prompt-input-review" onClick={onReviewWaiting}>{words.review}</Button>}
    {notice?.undo && <Button variant="link" size="xs" onClick={notice.undo}>{words.undo}</Button>}
    {!notice && held && uploadReason && <Button variant="link" size="xs" data-slot="prompt-input-cancel-held" onClick={() => { setHeld(false); editorRef.current?.focus(); }}>{words.cancel}</Button>}
  </p>;
  const sendEl = <SendButton
    status={sendStatus}
    generation={generation}
    empty={!canSend && !blockReason}
    blockedReason={!disabled ? blockReason : undefined}
    disabled={disabled}
    onStop={stop}
    onClick={send}
    type="button"
    labels={words}
  />;
  const editorEl =
    <div className="relative min-w-0 flex-1">
      {empty && <span aria-hidden data-slot="prompt-input-placeholder" className={cn('pointer-events-none absolute inset-x-0 top-0 truncate text-text-3 select-none', mode === 'shell' ? 'type-code pointer-coarse:type-code-touch' : 'type-body')}>
        {disabled ? words.off : mode === 'shell' ? words.shellPlaceholder : placeholder}
      </span>}
      <div
        ref={editorRef}
        // A text field over several lines that offers a list: textbox, since a combobox is one line. The list
        // and its option in focus still reach assistive tech through aria-controls and aria-activedescendant.
        role="textbox"
        aria-multiline
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-label={mode === 'shell' ? `${label}, ${words.shell}` : label}
        aria-placeholder={placeholder}
        aria-disabled={disabled || undefined}
        aria-describedby={[disabled && disabledReason ? reasonId : '', statusLine ? statusId : ''].filter(Boolean).join(' ') || undefined}
        aria-controls={menu && menu.kind !== 'commands' ? menuId : undefined}
        aria-activedescendant={menu && menu.kind !== 'commands' && options.length ? `${menuId}-${Math.min(active, options.length - 1)}` : undefined}
        aria-keyshortcuts="Enter Shift+Enter Escape"
        contentEditable={!disabled}
        suppressContentEditableWarning
        tabIndex={disabled ? -1 : 0}
        spellCheck={mode !== 'shell'}
        autoCapitalize={mode === 'shell' ? 'off' : undefined}
        autoCorrect={mode === 'shell' ? 'off' : undefined}
        data-slot="prompt-input-editor"
        // The root's edge turns ink on focus (data-focused); base.css leaves a [data-control] unringed.
        data-control=""
        onInput={() => { changed(); detectTrigger(); }}
        onKeyDown={onKeyDown}
        onKeyUp={event => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) || !menu) detectTrigger(); }}
        onClick={onEditorClick}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; detectTrigger(); }}
        onFocus={() => setFocused(true)}
        onBlur={event => {
          setFocused(false);
          if (menu?.kind !== 'commands' && !(event.relatedTarget as HTMLElement | null)?.closest('[data-slot="prompt-input-menu"]')) setMenu(null);
        }}
        onCopy={event => onCopy(event)}
        onCut={event => onCopy(event, true)}
        onPaste={onPaste}
        className={cn(
          inline ? 'max-h-[calc(var(--line-box)*8)] min-h-(--line-box)' : 'max-h-[calc(var(--line-box)*10)] min-h-[calc(var(--line-box)*2)]',
          'overflow-y-auto overscroll-contain break-words whitespace-pre-wrap text-text-1',
          mode === 'shell' ? 'type-code pointer-coarse:type-code-touch' : 'type-body',
          '[&_[data-slot=mention]]:mx-px [&_[data-mention-type=paste]]:cursor-pointer',
          disabled && 'cursor-not-allowed text-text-disabled',
        )}
      />
    </div>;

  return <div
    data-slot="prompt-input"
    data-state={state}
    data-mode={mode}
    data-layout={layout}
    data-held={held || undefined}
    data-dragging={dragging || undefined}
    data-focused={focused || undefined}
    className={cn(
      // A control: paper with the control line at rest, a little darker under the pointer, ink on focus.
      'relative flex w-full min-w-0 flex-col bg-page text-text-1 shadow-(--elev-control) frame [--frame-color:var(--line-control)]',
      // The edge eases to ink on focus.
      'transition-[outline-color,box-shadow] duration-(--dur-fast) ease-(--ease-step) before:transition-[border-color] before:duration-(--dur-fast) before:ease-(--ease-step)',
      'hover:not-data-focused:not-data-[state=disabled]:[--frame-color:var(--line-control-hover)]',
      'data-focused:[--frame-color:var(--border-focus)]! data-focused:shadow-(--focus-halo)',
      // A queue directly above shares the composer's top line.
      '[[data-slot=prompt-queue]+&]:-mt-px [[data-slot=prompt-queue]+&]:[--frame-radius:0_0_var(--radius-frame)_var(--radius-frame)]',
      'forced-colors:outline forced-colors:outline-1',
      className,
    )}
    {...dropProps}
    {...props}
  >
    {/* Chip templates: the editor clones these, so a chip in the editor is the same markup as <Mention>. */}
    <div ref={templatesRef} hidden aria-hidden>
      {(Object.keys(mentionTypeLabels) as MentionType[]).map(type => <Mention key={type} type={type} data-template={type} className="mx-px">x</Mention>)}
    </div>

    {disabled && disabledReason && <div id={reasonId} data-slot="prompt-input-reason" className="flex min-h-(--row) flex-wrap items-center gap-x-3 gap-y-2 py-1.5 ps-4 pe-1.5 rule-row">
      <span className="flex min-w-0 flex-1 items-center gap-2 type-body-sm text-text-1">
        <span className="min-w-0 break-words">{disabledReason}</span>
      </span>
      <span className="ms-auto empty:hidden">{disabledAction}</span>
    </div>}

    {attachments.length > 0 && <div ref={attachRef} data-slot="prompt-input-attachments" role="list" aria-label={words.attachments} className="flex flex-wrap gap-2 p-2 rule-row">
      {attachments.map((attachment, index) => <div role="listitem" key={attachment.id} className="min-w-0 max-w-full">
        <PromptAttachment
          attachment={attachment}
          labels={words}
          onRemove={onRemoveAttachment ? () => { attachIndex.current = index; onRemoveAttachment(attachment.id); } : undefined}
          onRetry={onRetryAttachment ? () => { attachIndex.current = index; onRetryAttachment(attachment.id); } : undefined}
        />
      </div>)}
    </div>}

    {!inline && <>
      {/* In shell mode the editor is a well: the one place in the composer where a person types code. */}
      <div data-slot="prompt-input-body" className={cn('relative flex min-w-0 gap-1.5 px-4 pt-3 pb-2', shellWell)}>
        {mode === 'shell' && <span aria-hidden data-slot="prompt-input-shell" className="type-code pt-px text-(--code-prompt) pointer-coarse:type-code-touch">$</span>}
        {editorEl}
      </div>

      <div data-slot="prompt-input-toolbar" className="@container/prompt-toolbar flex min-h-(--control-sm) min-w-0 flex-wrap items-center gap-1 px-2 pb-2">
        {attachEl}
        {/* The tools sit in line between attach and send, and take the free space (empty, they are the spacer). Only a
            toolbar under 320px moves them to their own row. */}
        <div inert={mode === 'shell'} className={cn('flex min-w-0 flex-1 basis-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] @max-xs/prompt-toolbar:order-last @max-xs/prompt-toolbar:basis-full @max-xs/prompt-toolbar:empty:hidden', mode === 'shell' && 'opacity-(--dim-opacity)')}>{tools}</div>
        {statusEl}
        {meta && <div data-slot="prompt-input-meta" className="shrink-0">{meta}</div>}
        {voice && <PromptInputMic size="sm" {...voice} disabled={disabled || voice.disabled}/>}
        {sendEl}
      </div>
    </>}

    {inline && <>
      {/* A slim row above the input for the notice, the held send or the calls waiting on the person. */}
      <div className={cn('flex min-h-(--row-sm) items-center px-4 rule-row', !statusLine && 'hidden')}>{statusEl}</div>

      {/* One row: attach, the text, the model chip, send. Everything is 28px and sits 8px from the edge, and when the
          text wraps the editor grows while the buttons stay on the bottom line (items-end). */}
      <div data-slot="prompt-input-body" className={cn('@container/prompt-toolbar relative flex min-w-0 items-end gap-1 p-2', shellWell)}>
        {attachEl}
        {/* The editor's line is 20px: 4px above and below it make the 28px the buttons share, so the text sits on their centers. */}
        <div className="flex min-w-0 flex-1 gap-1.5 px-1.5 py-1">
          {mode === 'shell' && <span aria-hidden data-slot="prompt-input-shell" className="type-code text-(--code-prompt) pointer-coarse:type-code-touch">$</span>}
          {editorEl}
        </div>
        <div inert={mode === 'shell'} className={cn('flex h-(--control-sm) shrink-0 items-center empty:hidden', mode === 'shell' && 'opacity-(--dim-opacity)')}>{tools}</div>
        {meta && <div data-slot="prompt-input-meta" className="flex h-(--control-sm) shrink-0 items-center">{meta}</div>}
        {voice && <PromptInputMic size="sm" {...voice} disabled={disabled || voice.disabled}/>}
        {sendEl}
      </div>
    </>}

    {/* The drop overlay: the accent wash with an ink edge, its words top-left. A refused type takes the fail wash and says why. */}
    {dragging && <div
      data-slot="prompt-input-drop"
      data-status={dragging === 'reject' ? 'fail' : undefined}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-(--z-cover) flex flex-col items-start gap-1 bg-accent-wash px-4 py-3 frame [--frame-color:var(--ink)] data-[status=fail]:[--frame-color:var(--fail-line)]"
    >
      <span className="type-label text-text-1">{words.drop}</span>
      {dragging === 'reject' && <span className="type-body-sm text-fail-text">{accept ? words.acceptOnly(describeAccept(accept)) : words.textOnly}</span>}
    </div>}
    <span className="sr-only" aria-live="polite">{menu ? words.results(options.length) : ''}</span>
    {menu && <TriggerMenu
      id={menuId}
      menu={menu}
      options={options}
      active={Math.min(active, Math.max(0, options.length - 1))}
      onHover={setActive}
      onPick={pick}
      title={menu.kind === '@' ? words.files : words.commands}
      empty={words.noMatches(menu.query)}
      typeLabel={option => words.types[option.mention.type]}
      search={menu.kind === 'commands' && <label className="search-row rule-row">
        <Icon icon={Search} size={16}/>
        <input
          ref={searchRef}
          role="combobox"
          aria-expanded
          aria-controls={menuId}
          aria-activedescendant={options.length ? `${menuId}-${Math.min(active, options.length - 1)}` : undefined}
          aria-label={words.searchCommands}
          placeholder={words.searchCommands}
          // Focus draws the row's ink edge; the field takes no outline.
          data-control=""
          value={menu.query}
          onChange={event => { setActive(0); setMenu(m => (m ? {...m, query: event.target.value} : m)); }}
          onBlur={event => { if (!(event.relatedTarget as HTMLElement | null)?.closest('[data-slot="prompt-input-menu"]')) setMenu(null); }}
          onKeyDown={event => {
            if (isComposing(event)) return;
            const count = options.length;
            if (event.key === 'ArrowDown' && count) { event.preventDefault(); setActive(i => (i + 1) % count); }
            if (event.key === 'ArrowUp' && count) { event.preventDefault(); setActive(i => (i - 1 + count) % count); }
            if ((event.key === 'Enter' || event.key === 'Tab') && count) { event.preventDefault(); pick(options[Math.min(active, count - 1)]); }
            if (event.key === 'Escape') { consume(event); closeMenu(true); }
          }}
          className="search-field"
        />
      </label>}
    />}
  </div>;
}

/** The model picker as a quiet chip: the model's name in small text-2 and a chevron, a 4px wash on hover. Pass `tools`. Wire onClick to a menu of your models. */
function PromptInputModel({model, children, className, ...props}: Omit<ButtonProps, 'variant' | 'size'> & {model: string}) {
  return <Button variant="ghost" size="xs" aria-label={`Model, ${model}`} className={cn('text-text-2', className)} {...props}>
    {model}<Icon icon={ChevronDown} size={12}/>
  </Button>;
}

export {
  PromptInput, PromptInputModel, PromptAttachment, PromptQueue, PromptInputMic, serialize as serializePrompt, accepts as acceptsFile,
  type PromptInputProps, type PromptInputHandle, type PromptInputLabels, type PromptValue, type PromptMention, type PromptMode, type MentionItem, type CommandItem,
  type Attachment, type PromptAttachmentProps, type PromptAttachmentLabels, type QueuedMessage, type PromptQueueProps, type PromptQueueLabels,
  type PromptInputMicProps, type PromptInputMicLabels, type MicState,
};
