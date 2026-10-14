import {mentionToText, type MentionRef, type MentionType} from '@/components/quartz/ai/mention';

// The prompt's text forms. The editor is DOM; serialize walks it into the plain text a person reads, the
// serialized form a model reads, and the codec the clipboard and the saved draft carry, where a paste stays
// one chip.

type PromptMention = MentionRef;
type PromptMode = 'normal' | 'shell';
type PromptValue = {
  /** Plain text: chips as @label or /label, pastes in full. */
  text: string;
  /** The same text with chips as [label](type:id), pastes in full. Send this to a model that reads links. */
  serialized: string;
  mentions: PromptMention[];
  mode: PromptMode;
};

const CODEC_TYPE = 'application/x-quartz-prompt';
const DRAFT_PREFIX = 'quartz:prompt-draft:';
const PASTE_LINES = 3;
const PASTE_CHARS = 150;

const prefix = (type: MentionType) => (type === 'command' ? '/' : type === 'paste' ? '' : '@');
/** An IME is composing: isComposing, or keyCode 229, which WebKit sends after compositionend. */
const isComposing = (event: React.KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

/** Walks editor DOM into plain text, the serialized form, the codec (pastes collapsed) and the mentions. */
function serialize(root: Node, pastes: Map<string, string>) {
  let text = '';
  let serialized = '';
  let codec = '';
  const mentions: PromptMention[] = [];
  const add = (plain: string, link = plain, raw = link) => { text += plain; serialized += link; codec += raw; };
  const walk = (node: Node) => {
    node.childNodes.forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) {
        add((child.nodeValue ?? '').replace(/ /g, ' ').replace(/​/g, ''));
      } else if (child instanceof HTMLElement) {
        const {mentionId: id, mentionType, mentionLabel: label} = child.dataset;
        if (id !== undefined && mentionType && label !== undefined) {
          const type = mentionType as MentionType;
          const ref = {id, type, label};
          if (type === 'paste') {
            // A paste is its own block: a line break before it unless one is already there, and one after.
            const body = `${text && !/\n\s*$/.test(text) ? '\n' : ''}${pastes.get(id) ?? ''}\n`;
            add(body, body, mentionToText(ref));
          } else {
            mentions.push(ref);
            add(`${prefix(type)}${label}`, mentionToText(ref));
          }
        } else if (child.tagName === 'BR') {
          add('\n');
        } else if (!child.hasAttribute('data-template')) {
          if ((child.tagName === 'DIV' || child.tagName === 'P') && text && !text.endsWith('\n')) add('\n');
          walk(child);
        }
      }
    });
  };
  walk(root);
  return {text, serialized, codec, mentions};
}

/** Lines as a person counts them: a trailing newline (how copied lines usually end) is not a line. */
const lineCount = (body: string) => body.replace(/\n$/, '').split('\n').length;

export {
  serialize, lineCount, isComposing, CODEC_TYPE, DRAFT_PREFIX, PASTE_LINES, PASTE_CHARS,
  type PromptMention, type PromptMode, type PromptValue,
};
