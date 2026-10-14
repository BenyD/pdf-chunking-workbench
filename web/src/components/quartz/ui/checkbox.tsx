'use client';

import {Checkbox as CheckboxPrimitive} from '@base-ui/react/checkbox';
import {CheckboxGroup as CheckboxGroupPrimitive} from '@base-ui/react/checkbox-group';
import {Icon, Checkmark, Subtract} from '@/components/quartz/icon';
import {cn, mergeClass} from '@/lib/quartz/utils';

// Quartz's checkbox, on Base UI's Checkbox. A 16px square with the 6px soft corner.
// Unticked is paper with a 1px control edge (control-edge) at --border-control, the 3:1 edge a tick box needs
// (a field's quiet edge would fail it), and it turns ink on hover. Ticked and mixed are solid ink with a paper
// glyph, so the state reads from the fill. Invalid (aria-invalid) turns the edge to the fail line; the fill stays ink and the component never names
// a hue.
// The hit area grows past the box with an ::after, so a 16px box still takes a 28px target.
// The box stops its click from bubbling, so ticking a checkbox inside a clickable row never opens the row.
//
// Select-all: inside CheckboxGroup with `allValues`, a Checkbox with `parent` derives its own state
// from its children: all ticked is checked, some is mixed, none is clear. Pressing it from mixed ticks
// all, then clears all, then brings back the mix the person made, so select-all never destroys a
// hand-picked set.
//
// Forced colors drop the edge colour and the fill, so the box draws a system-colored border and a ticked box
// keeps a Highlight fill.

type CheckboxProps = CheckboxPrimitive.Root.Props & {'aria-invalid'?: boolean | 'true' | 'false'};

function Checkbox({className, 'aria-invalid': invalid, onClick, ...props}: CheckboxProps) {
  const isInvalid = invalid === true || invalid === 'true';
  return <CheckboxPrimitive.Root
    data-slot="checkbox"
    data-status={isInvalid ? 'fail' : undefined}
    aria-invalid={isInvalid || undefined}
    onClick={event => { onClick?.(event); event.stopPropagation(); }}
    className={mergeClass([
      'peer relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-soft [-webkit-tap-highlight-color:transparent]',
      'bg-page text-text-inverse control-edge [--frame-color:var(--border-control)] transition-[background-color,box-shadow,outline-color] duration-(--dur-fast) ease-(--ease-step)',
      'not-pointer-coarse:after:absolute not-pointer-coarse:after:-inset-1.5 touch-target',
      'hover:not-data-disabled:not-data-readonly:not-data-checked:not-data-indeterminate:not-aria-invalid:[--frame-color:var(--ink)]',
      'data-checked:bg-ink data-indeterminate:bg-ink',
      'active:not-data-disabled:not-data-readonly:not-data-checked:not-data-indeterminate:bg-pressed active:not-data-disabled:not-data-readonly:data-checked:bg-button-primary-hover active:not-data-disabled:not-data-readonly:data-indeterminate:bg-button-primary-hover active:not-data-disabled:not-data-readonly:duration-(--dur-press)',
      // Invalid: the fail edge, no wash. Disabled: a fainter edge on paper, and no lift.
      'aria-invalid:[--frame-color:var(--fail-line)] aria-invalid:data-checked:bg-ink aria-invalid:data-indeterminate:bg-ink',
      'data-disabled:cursor-not-allowed data-disabled:bg-page data-disabled:[--frame-color:var(--text-disabled)] data-disabled:[--control-lift:var(--elev-none)] data-disabled:text-text-inverse',
      'data-disabled:data-checked:bg-text-disabled data-disabled:data-indeterminate:bg-text-disabled',
      'data-readonly:cursor-default',
      'forced-colors:border forced-colors:border-solid forced-colors:border-[CanvasText]',
      'forced-colors:data-checked:[forced-color-adjust:none] forced-colors:data-checked:bg-[Highlight]! forced-colors:data-checked:text-[HighlightText]!',
      'forced-colors:data-indeterminate:[forced-color-adjust:none] forced-colors:data-indeterminate:bg-[Highlight]! forced-colors:data-indeterminate:text-[HighlightText]!',
      'forced-colors:data-disabled:border-[GrayText] forced-colors:data-disabled:data-checked:bg-[GrayText]!',
    ], className)}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      data-slot="checkbox-indicator"
      className="grid place-content-center text-current"
      render={(indicatorProps, state) => <span {...indicatorProps}>
        <Icon icon={state.indeterminate ? Subtract : Checkmark} size={12}/>
      </span>}
    />
  </CheckboxPrimitive.Root>;
}

/** A set of checkboxes with one value array. Give it `allValues` to let a `parent` Checkbox select all. */
function CheckboxGroup({className, ...props}: CheckboxGroupPrimitive.Props) {
  return <CheckboxGroupPrimitive data-slot="checkbox-group" className={mergeClass('flex flex-col gap-2', className)} {...props}/>;
}

export {Checkbox, CheckboxGroup, type CheckboxProps};
