import {mergeProps} from '@base-ui/react/merge-props';
import {useRender} from '@base-ui/react/use-render';
import {cva, type VariantProps} from 'class-variance-authority';
import {Icon, CollapseAll, StopOutline} from '@/components/quartz/icon';
import {Avatar} from '@/components/quartz/ui/avatar';
import {Button} from '@/components/quartz/ui/button';
import {Badge} from '@/components/quartz/ui/badge';
import {InkSlot, Status, statusLabels} from '@/components/quartz/ui/status';
import type {Kind} from '@/lib/quartz/kind';
import {cn, withDefaults} from '@/lib/quartz/utils';

// One turn in a conversation, plus the dividers between turns (was Message, Bubble and Marker).
//
// Two layouts, one thread column. Both turns inset 16px from the edge.
// - The agent's turn is message flow: the sections at the full width (AgentTurn reads the name, state and time aloud and
//   draws them only for a turn that failed or stopped), with no frame and no fill: optional reasoning,
//   tool rows (ToolCallList), the answer in prose (Response), and a footer with its actions and the model that answered
//   (MessageModel). The order is fixed and every section is optional. The live state is the running tool row, so the
//   header says nothing about it; MessageStatus only carries the state for the footer (hidden while live or waiting) and
//   speaks it aloud, and shows a word at the end of the header for a turn that failed or stopped.
// - The person's turn is a bubble at the end of the row: paper, the frame line, up to 85% of the width. Their name and
//   the time are in the header for screen readers and not drawn. A message that did not send keeps its text and the whole
//   row takes the fail wash, with Retry in place (MessageSendState).
// - MessageModel names the model that answered as quiet mono text in the footer, so a turn answered by a fallback says so.
// - MessageDivider marks a point in the thread. Quiet dividers (interrupted, compaction, day, a handoff to an
//   agent) are a faint rule with a label anchored left. A handoff to a person is a grey rule with the InkSlot
//   label in its centre, because from then until they reply the thread waits on them.
// When the agent header is drawn (a failed or stopped turn) it puts the time in the --time-column at its end, so the times line up down a thread.
// No state of its own.

const messageVariants = cva('group/message relative flex w-full min-w-0', {
  variants: {
    size: {
      default: 'type-body',
      sm: 'type-body-sm',
    },
  },
  defaultVariants: {size: 'default'},
});

// The agent's turn: plain flow at the full width. No frame, no avatar column: an avatar in a MessageAvatar slot is hidden.
const agentTurn = 'px-4 py-2 *:data-[slot=message-avatar]:hidden';

// The person's row. A failed send washes the whole row in the fail step.
const personRow = [
  'justify-end px-4 py-2 *:data-[slot=message-avatar]:hidden',
  'has-[[data-slot=message-send-state][data-state=failed]]:[--accent-wash:var(--fail-wash)] has-[[data-slot=message-send-state][data-state=failed]]:bg-accent-wash',
  'has-[[data-slot=message-bubble][data-variant=destructive]]:[--accent-wash:var(--fail-wash)] has-[[data-slot=message-bubble][data-variant=destructive]]:bg-accent-wash',
];

function MessageGroup({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="message-group" className={cn('flex min-w-0 flex-col gap-4', className)} {...props}/>;
}

type MessageProps = React.ComponentProps<'div'> & VariantProps<typeof messageVariants> & {
  /** Who speaks. `person` is the deprecated v1 name for `user`. */
  from?: 'agent' | 'user' | 'person';
  /** Flips the person's row so the avatar sits at the end. Discouraged: both speakers start at the left edge. */
  align?: 'start' | 'end';
  /** The kind for an agent turn. Defaults to agent. */
  kind?: Kind;
};

function Message({className, from = 'agent', align = 'start', size = 'default', kind, ...props}: MessageProps) {
  const who = from === 'person' ? 'user' : from;
  return <div
    data-slot="message"
    data-from={who}
    data-align={align}
    data-size={size}
    data-kind={who === 'agent' ? (kind ?? 'agent') : kind}
    className={cn(messageVariants({size}), who === 'agent' ? agentTurn : personRow, className)}
    {...props}
  />;
}

/** @deprecated An avatar slot kept for older call sites. Neither turn has an avatar, so nothing draws it. */
function MessageAvatar({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="message-avatar" aria-hidden className={cn('flex h-(--control-xs) shrink-0 items-center self-start', className)} {...props}/>;
}

/** @deprecated The agent's avatar slot, kept for older call sites. An agent turn has no avatar. */
function MessageAgentAvatar({name, className, ...props}: Omit<React.ComponentProps<typeof MessageAvatar>, 'children'> & {name: string}) {
  return <MessageAvatar className={className} {...props}><Avatar size="sm" type="agent" name={name} decorative/></MessageAvatar>;
}

/**
 * A whole agent turn in one piece: the sections, with the header (name, state, time) read aloud and not drawn, the way
 * a person's is. A turn that failed or stopped draws the header so its word shows. Blocks use it so every turn in a
 * thread shares one layout.
 */
function AgentTurn({name, time, state = 'done', children, ...props}: Omit<React.ComponentProps<typeof Message>, 'from' | 'children'> & {name: string; time?: React.ReactNode; state?: MessageStatusProps['state']; children?: React.ReactNode}) {
  return <Message from="agent" {...props}>
    <MessageContent>
      <MessageHeader className={state === 'fail' || state === 'stopped' ? undefined : 'sr-only'}>{name}<MessageStatus state={state}/>{time && <MessageTime>{time}</MessageTime>}</MessageHeader>
      {children}
    </MessageContent>
  </Message>;
}

function MessageContent({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="message-content"
    className={cn(
      'flex min-w-0 flex-1 flex-col break-words text-text-1',
      // The person's turn: a bubble at the end, up to 85% of the width; their name and time are hidden.
      'group-data-[from=user]/message:max-w-[85%] group-data-[from=user]/message:flex-none group-data-[from=user]/message:items-end group-data-[from=user]/message:gap-1',
      'group-data-[from=user]/message:*:data-[slot=message-header]:sr-only',
      // The agent's turn: each child is a section, set apart by space.
      'group-data-[from=agent]/message:gap-2',
      className,
    )}
    {...props}
  />;
}

/**
 * The speaker's name, then MessageStatus and MessageTime at the end: one small quiet line above the content, on
 * both speakers. A Badge or MessageModel left in an agent's header from older call sites is hidden; the model moves
 * to the footer.
 */
function MessageHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="message-header"
    className={cn(
      'flex min-w-0 items-center gap-2 type-label text-text-1 *:data-[slot=message-meta]:type-body-sm *:data-[slot=message-meta]:text-text-3',
      'min-h-(--control-xs) group-data-[from=agent]/message:shrink-0 group-data-[from=agent]/message:type-body-sm group-data-[from=agent]/message:text-text-2',
      'group-data-[from=agent]/message:*:data-[slot=badge]:hidden group-data-[from=agent]/message:*:data-[slot=message-model]:hidden',
      className,
    )}
    {...props}
  />;
}

function MessageMeta({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="message-meta" className={cn('min-w-0 truncate data', className)} {...props}/>;
}

/** The turn's time, in the end column every turn shares, so times line up down the thread. */
function MessageTime({className, ...props}: React.ComponentProps<'time'>) {
  return <time
    data-slot="message-time"
    className={cn('ms-auto w-(--time-column) shrink-0 truncate text-end type-body-sm text-text-3 data [[data-slot=message-status]~&]:ms-0', className)}
    {...props}
  />;
}

/**
 * The model that answered this turn, as quiet mono text for the footer. When it is not the model the person picked (a
 * fallback after a rate limit), pass `requested`: "for model-l" follows it.
 */
function MessageModel({model, requested, forModel = name => `for ${name}`, className, ...props}: Omit<React.ComponentProps<'span'>, 'children'> & {
  model: string;
  requested?: string;
  /** The words after a fallback model, from the one the person picked: "for model-l". For another language. */
  forModel?: (requested: string) => string;
}) {
  const switched = requested !== undefined && requested !== model;
  return <span data-slot="message-model" data-switched={switched || undefined} className={cn('inline-flex min-w-0 items-baseline gap-1.5 text-text-3', className)} title={switched ? `${model} ${forModel(requested)}` : model} {...props}>
    <span className="min-w-0 truncate type-tag">{model}</span>
    {switched && <span className="min-w-0 truncate type-body-sm">{forModel(requested)}</span>}
  </span>;
}

type MessageStatusLabels = {working?: string; paused?: string; failed?: string; stopped?: string};
const statusWords: Required<MessageStatusLabels> = {working: statusLabels.running, paused: statusLabels.waiting, failed: statusLabels.fail, stopped: 'Stopped'};

type MessageStatusProps = Omit<React.ComponentProps<'span'>, 'children'> & {
  /** Where the turn stands. live and waiting hide the footer; fail and stopped say so at the end of the header. */
  state: 'live' | 'waiting' | 'fail' | 'stopped' | 'done';
  /** Replaces the word for this state. */
  label?: string;
  /** The default words, for another language. */
  labels?: MessageStatusLabels;
};

/**
 * The agent turn's state, in its MessageHeader. One per turn: the footer reads it, so the state lives in one place.
 * Live, waiting and done show nothing (the running tool row, or the approval card, is the live thing) and are read
 * aloud; a failed turn shows a red "Failed" and a stopped one a quiet "Stopped" at the end of the line.
 */
function MessageStatus({state, label, labels, className, ...props}: MessageStatusProps) {
  const words = withDefaults(statusWords, labels);
  const content = state === 'fail' ? <Status status="fail">{label ?? words.failed}</Status>
    : state === 'stopped' ? <span>{label ?? words.stopped}</span>
      : state === 'live' ? <span className="sr-only">{label ?? words.working}</span>
        : state === 'waiting' ? <span className="sr-only">{label ?? words.paused}</span>
          : label ? <span className="sr-only">{label}</span> : null;
  return <span
    data-slot="message-status"
    data-state={state}
    className={cn('ms-auto inline-flex shrink-0 items-center justify-end type-body-sm whitespace-nowrap text-text-3', className)}
    {...props}
  >{content}</span>;
}

/**
 * The agent turn's last section, under a finished turn: a quiet line ("Worked for 14s, 14:02", MessageWorked), copy
 * and retry as 28px ghost icon buttons that show on hover or focus where there is a pointer, and at the end the model
 * that answered (MessageModel) and a summary (MessageMeta). Hidden while the turn is live or waiting. On touch the
 * buttons are always shown, since there is no hover to reveal them.
 */
function MessageFooter({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="message-footer"
    className={cn(
      'flex min-h-(--row-sm) max-w-full min-w-0 shrink-0 items-center gap-0.5 type-body-sm text-text-2',
      'group-data-[from=agent]/message:-ms-2 *:data-[slot=message-model]:ms-auto *:data-[slot=message-meta]:ms-auto *:data-[slot=message-meta]:text-text-2 [&>[data-slot=message-model]+[data-slot=message-meta]]:ms-3',
      // The buttons wait for a pointer to arrive on the turn or a key to land in the footer; a keyboard user is never left without them.
      'pointer-fine:group-data-[from=agent]/message:*:data-[slot=button]:opacity-0 pointer-fine:group-data-[from=agent]/message:group-hover/message:*:data-[slot=button]:opacity-100 pointer-fine:group-data-[from=agent]/message:*:data-[slot=button]:focus-visible:opacity-100 pointer-fine:group-data-[from=agent]/message:*:data-[slot=button]:transition-opacity pointer-fine:group-data-[from=agent]/message:*:data-[slot=button]:duration-(--dur-fast)',
      'group-has-[[data-slot=message-status]:is([data-state=live],[data-state=waiting])]/message:hidden',
      'group-data-[from=user]/message:-ms-2 group-data-[from=user]/message:min-h-(--control-sm)',
      className,
    )}
    {...props}
  />;
}

type MessageWorkedLabels = {worked?: (duration: string) => string};
const workedLabels: Required<MessageWorkedLabels> = {worked: duration => `Worked for ${duration}`};

/**
 * The footer's first words: how long the turn worked and when it ended, "Worked for 14s, 14:02", in text-3. Pass
 * `duration` already formatted (formatDuration from the tool-call item); with only a `time` it reads the time alone.
 * It sits on the text column, since the buttons after it carry their own 8px.
 */
function MessageWorked({duration, time, labels, className, ...props}: Omit<React.ComponentProps<'span'>, 'children'> & {
  duration?: string;
  time?: React.ReactNode;
  /** The words for another language. */
  labels?: MessageWorkedLabels;
}) {
  const words = withDefaults(workedLabels, labels);
  return <span data-slot="message-worked" className={cn('me-1 ms-2 inline-flex min-w-0 items-baseline gap-1.5 truncate type-body-sm text-text-3 data', className)} {...props}>
    {duration && <span className="min-w-0 truncate">{words.worked(duration)}{time && ','}</span>}
    {time && <span className="shrink-0">{time}</span>}
  </span>;
}

// ---------- Bubble ----------

// The person's words. Inside a person's turn every variant but inverse is the paper bubble with the frame line.
//   default      plain text, wrapping at the reading measure; in a person's turn the paper bubble
//   ghost        the same; kept for older call sites
//   outline      a control-line frame with padding, for a quoted or edited draft
//   tinted       an outline whose line takes the kind's line step. Deprecated: use outline with a kind
//   inverse      ink with paper text, for the one pinned instruction a person set
//   destructive  deprecated: use status="fail". The paper bubble; the whole row takes the fail wash, for a message that did not send
// The paper bubble of a person's turn. Only the variants that are not inverse take it, so the inverse fill never fights
// the paper one for the same background and frame.
// Written out in full: Tailwind finds a class only as one whole token.
const paperBubble = 'group-data-[from=user]/message:*:data-[slot=message-bubble-content]:bg-page group-data-[from=user]/message:*:data-[slot=message-bubble-content]:frame group-data-[from=user]/message:*:data-[slot=message-bubble-content]:px-3.5 group-data-[from=user]/message:*:data-[slot=message-bubble-content]:py-2';

const bubbleVariants = cva(
  ['group/bubble relative flex w-full max-w-(--measure) min-w-0 flex-col gap-1', 'data-[align=end]:self-end', 'group-data-[from=user]/message:w-auto'],
  {
    variants: {
      variant: {
        default: paperBubble,
        ghost: paperBubble,
        destructive: paperBubble,
        inverse: '*:data-[slot=message-bubble-content]:rounded-frame *:data-[slot=message-bubble-content]:bg-inverse *:data-[slot=message-bubble-content]:px-3 *:data-[slot=message-bubble-content]:py-2 *:data-[slot=message-bubble-content]:text-text-inverse',
        outline: '*:data-[slot=message-bubble-content]:frame *:data-[slot=message-bubble-content]:px-3 *:data-[slot=message-bubble-content]:py-2 *:data-[slot=message-bubble-content]:[--frame-color:var(--line-control)] group-data-[from=user]/message:*:data-[slot=message-bubble-content]:bg-page',
        tinted: '*:data-[slot=message-bubble-content]:frame *:data-[slot=message-bubble-content]:px-3 *:data-[slot=message-bubble-content]:py-2 *:data-[slot=message-bubble-content]:[--frame-color:var(--accent-line)] group-data-[from=user]/message:*:data-[slot=message-bubble-content]:bg-page',
      },
    },
    defaultVariants: {variant: 'default'},
  },
);

type MessageBubbleProps = React.ComponentProps<'div'> & VariantProps<typeof bubbleVariants> & {
  align?: 'start' | 'end';
  /** The kind whose line an outline or tinted bubble takes. */
  kind?: Kind;
  /** fail: the row takes the fail wash, for a message that did not send. */
  status?: 'fail';
};

function MessageBubble({variant: asked = 'default', status, align = 'start', kind, className, ...props}: MessageBubbleProps) {
  const variant = status === 'fail' ? 'destructive' : asked;
  return <div
    data-slot="message-bubble"
    data-variant={variant}
    data-align={align}
    data-kind={kind}
    className={cn(bubbleVariants({variant}), className)}
    {...props}
  />;
}

function MessageBubbleContent({className, render, ...props}: useRender.ComponentProps<'div'>) {
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        className: cn(
          'w-fit max-w-full min-w-0 type-body break-words whitespace-pre-wrap text-text-1 [overflow-wrap:anywhere]',
          'group-data-[align=end]/bubble:self-end [button]:text-start [button,a]:rounded-soft [button,a]:transition-colors [button,a]:duration-(--dur-fast) [button,a]:ease-(--ease-step)',
          // Hover only when the content is a button or link, through the hover variant so the docs can force it.
          '[&:is(button,a)]:hover:bg-hover [&:is(button,a)]:hover:group-data-[variant=inverse]/bubble:bg-button-primary-hover',
          className,
        ),
      },
      props,
    ),
    render,
    state: {slot: 'message-bubble-content'},
  });
}

/** A 20px strip under the text for reactions or a read receipt: each reaction a small box with a control line. */
function MessageReactions({className, ...props}: React.ComponentProps<'div'>) {
  return <div
    data-slot="message-reactions"
    dir="auto"
    className={cn('flex min-h-5 w-fit flex-wrap items-center gap-1 type-label-sm text-text-1 data *:inline-flex *:h-5 *:items-center *:gap-1 *:rounded-inner *:px-1.5 *:control-edge', className)}
    {...props}
  />;
}

/**
 * Whether the person's message reached the agent. Sending shows quiet text; failed keeps the text, washes the row,
 * says so and offers Retry on the same line, so nothing the person wrote is lost.
 */
type MessageSendStateLabels = {sending?: string; notSent?: string; retry?: string};
const sendStateLabels: Required<MessageSendStateLabels> = {sending: 'Sending', notSent: 'Not sent', retry: 'Retry'};

function MessageSendState({state, onRetry, labels, className, ...props}: Omit<React.ComponentProps<'div'>, 'children'> & {
  state: 'sending' | 'sent' | 'failed';
  onRetry?: () => void;
  /** The status words and Retry, for another language. */
  labels?: MessageSendStateLabels;
}) {
  const words = withDefaults(sendStateLabels, labels);
  if (state === 'sent') return null;
  return <div
    data-slot="message-send-state"
    data-state={state}
    data-status={state === 'failed' ? 'fail' : undefined}
    className={cn('relative flex min-h-(--control-sm) items-center gap-2 type-body-sm text-text-3', className)}
    {...props}
  >
    <span role="status">{state === 'sending' ? words.sending : <Status status="fail">{words.notSent}</Status>}</span>
    {state === 'failed' && onRetry && <Button variant="ghost" size="sm" onClick={onRetry}>{words.retry}</Button>}
  </div>;
}

// ---------- Divider ----------

const dividerVariants = cva(
  [
    'group/divider relative flex min-h-(--control-xs) w-full items-center gap-2 text-start type-label-sm text-text-3',
    "[&_svg:not([class*='size-'])]:size-4 [&_a]:text-text-1 [&_a]:underline [&_a]:decoration-1 [&_a]:underline-offset-4",
  ],
  {
    variants: {
      variant: {
        default: '',
        // The quiet form: a label anchored left, then a faint rule to the end.
        separator: 'after:h-px after:min-w-4 after:flex-1 after:bg-line-row',
        border: 'pb-2 rule-row',
        // A handoff to a person: a grey rule with the InkSlot label in its centre, the one centred thing in a thread.
        ink: 'before:h-px before:min-w-4 before:flex-1 before:bg-frame after:h-px after:min-w-4 after:flex-1 after:bg-frame forced-colors:before:bg-[CanvasText] forced-colors:after:bg-[CanvasText]',
      },
    },
    defaultVariants: {variant: 'default'},
  },
);

type DividerReason = 'compaction' | 'interrupted' | 'handoff' | 'day';
const reasonLabel: Partial<Record<DividerReason, string>> = {compaction: 'Context compacted', interrupted: 'Interrupted'};
const reasonIcon = {compaction: CollapseAll, interrupted: StopOutline} as const;

type MessageDividerProps = useRender.ComponentProps<'div'> & VariantProps<typeof dividerVariants> & {
  /** Why the thread is divided here. Sets the default words, glyph and form. `handoff` with no kind is a handoff to a person. */
  reason?: DividerReason;
  /** The kind the divider names, such as the agent a task was handed to. Shows its kind label before the text. */
  kind?: Kind;
  /** The default words for a reason, for another language. Children replace them for one divider. */
  labels?: Partial<Record<DividerReason, string>>;
};

function MessageDivider({className, variant, reason, kind, labels, render, children, ...props}: MessageDividerProps) {
  const reasonText = reason ? (labels?.[reason] ?? reasonLabel[reason]) : undefined;
  const toPerson = reason === 'handoff' && !kind;
  const v = variant ?? (toPerson ? 'ink' : reason ? 'separator' : 'default');
  const glyph = reason === 'compaction' || reason === 'interrupted' ? reasonIcon[reason] : undefined;
  const text = children ?? reasonText ?? null;
  return useRender({
    defaultTagName: 'div',
    props: mergeProps<'div'>(
      {
        role: 'separator',
        className: cn(dividerVariants({variant: v}), className),
        children: v === 'ink'
          ? <InkSlot data-slot="message-divider-content" className="min-w-0 truncate">{text}</InkSlot>
          : <>
              {kind && <Badge kind={kind} data-slot="message-divider-kind"/>}
              {glyph && <span data-slot="message-divider-icon" aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center text-text-3"><Icon icon={glyph} size={16}/></span>}
              <span data-slot="message-divider-content" className="min-w-0 shrink break-words">{text}</span>
            </>,
      },
      {'data-kind': kind, 'data-reason': reason, 'data-variant': v, 'aria-label': typeof children === 'string' ? children : reasonText} as React.ComponentProps<'div'>,
      props,
    ),
    render,
    state: {slot: 'message-divider', variant: v},
  });
}

/** A glyph slot for a custom divider. */
function MessageDividerIcon({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="message-divider-icon" aria-hidden className={cn('inline-flex size-4 shrink-0 items-center justify-center text-text-3', className)} {...props}/>;
}

export {
  MessageGroup, Message, AgentTurn, MessageAvatar, MessageAgentAvatar, MessageContent, MessageHeader, MessageMeta, MessageTime, MessageModel, MessageStatus, MessageFooter, MessageWorked,
  MessageBubble, MessageBubbleContent, MessageReactions, MessageSendState, MessageDivider, MessageDividerIcon,
  messageVariants, bubbleVariants, dividerVariants,
  type MessageProps, type MessageStatusProps, type MessageStatusLabels, type MessageWorkedLabels, type MessageSendStateLabels, type MessageBubbleProps, type MessageDividerProps, type DividerReason,
};
