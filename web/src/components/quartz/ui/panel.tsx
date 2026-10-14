import {cn} from '@/lib/quartz/utils';
import {ButtonSize} from '@/components/quartz/ui/button';

// Quartz's panel is the widget: a grey outer (--surface-frame) with the frame line, the header on the grey, the content in a white bordered
// PanelBody 4px in from the edge, and the footer back on the grey. It holds a summary: an overview widget, a chart widget,
// a short list (about 8 rows at most, an API keys list), a short read-only fact (an environment and its workspace ID), or a
// card that asks the person for a decision (a prompt release with Roll back and Resume rollout in the footer). It never
// scrolls inside and never holds a Card; link to a full page for more. A Card is the working surface (a big table or
// stream, a trace, a log, code, a form with fields the person edits, the detail of one object), white with one grey edge
// and a rule under its header. A summary or a decision is a Panel and a working surface or an edited field group is a
// Card; never a Card inside a Panel or a Panel inside a Card. Dialog and Sheet share the grey shell (a white header card
// with the title, description and close, the body continuing it, the actions on the grey), and Chart frame="panel"
// follows the Panel anatomy. The header and footer come from the shared frame-head and frame-foot utilities
// (styles.css), the same ones Card, Table, Chart, CodeBlock, LogViewer and Timeline use.

function Panel({className, ...props}: React.ComponentProps<'section'>) {
  return <section data-slot="panel" className={cn('relative flex min-w-0 flex-col overflow-hidden bg-(--surface-frame) text-text-1 frame forced-colors:outline forced-colors:outline-1', className)} {...props}/>;
}

/** The 40px header on the grey, with no rule under it. Title and meta on the start, one PanelAction at the end. */
function PanelHeader({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="panel-header" className={cn('frame-head', className)} {...props}/>;
}

function PanelTitle({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="panel-title" className={cn('min-w-0 truncate type-label text-text-1', className)} {...props}/>;
}

/** Quiet text after the title: a count, an environment, a time. */
function PanelMeta({className, ...props}: React.ComponentProps<'span'>) {
  return <span data-slot="panel-meta" className={cn('shrink-0 type-label text-text-3 data', className)} {...props}/>;
}

/** The header's one action, at the end, 8px from the edge. */
function PanelAction({className, children, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="panel-action" className={cn('frame-head-action', className)} {...props}><ButtonSize size="xs">{children}</ButtonSize></div>;
}

/**
 * The content: one white bordered group 4px inside the grey, its corner the frame's minus that gap. Rows inside take
 * rule-row; the last row drops it because the group's line is right below. The 4px at the bottom goes when a footer follows.
 */
function PanelBody({className, ...props}: React.ComponentProps<'div'>) {
  return <div data-slot="panel-body" className={cn('frame mx-1 mb-1 flex min-w-0 flex-col bg-page [--frame-color:var(--line-row)] [--frame-radius:calc(var(--radius-frame)-4px)] has-[+[data-slot=panel-footer]]:mb-0', className)} {...props}/>;
}

/** Back on the grey under the body: a quiet line on the start, or actions at the end, 44px tall so a 28px sm button sits 8px from every edge. */
function PanelFooter({className, children, ...props}: React.ComponentProps<'div'>) {
  // Buttons here are sm (28px) unless named otherwise. A footer that holds buttons puts them at the end; a quiet line stays at the start.
  return <div data-slot="panel-footer" className={cn('frame-foot type-body-sm text-text-3 has-[button]:justify-end', className)} {...props}><ButtonSize size="sm">{children}</ButtonSize></div>;
}

export {Panel, PanelHeader, PanelTitle, PanelMeta, PanelAction, PanelBody, PanelFooter};
