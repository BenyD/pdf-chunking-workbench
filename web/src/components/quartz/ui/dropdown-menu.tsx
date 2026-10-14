'use client';

import * as React from 'react';
import {Menu as MenuPrimitive} from '@base-ui/react/menu';
import {ContextMenu as ContextMenuPrimitive} from '@base-ui/react/context-menu';
import {overlayMotion, overlaySurface} from '@/lib/quartz/overlay';
import {Icon, ChevronRight, Checkmark} from '@/components/quartz/icon';
import {cn, mergeClass} from '@/lib/quartz/utils';
import {useQuartzPortal} from '@/lib/quartz/portal';
import {Kbd, KbdGroup} from '@/components/quartz/ui/kbd';

// Quartz's dropdown menu, on Base UI's Menu and ContextMenu. One list of actions,
// two ways to open it:
//
//   <DropdownMenu>                       a trigger button opens it below
//   <DropdownMenu trigger="contextmenu"> a right click, a long press on touch, or Shift+F10 opens it at
//                                        the pointer over an area such as a table
//
// Paper, 10px frame radius, the overlay shadow, 4px padding; 32px items in the 14px label role. The
// highlighted item takes the hover wash; a destructive item reads in the fail word and takes the fail wash when highlighted.
// Arrow keys move, typing jumps to an item, Enter or Space runs it, Escape closes this menu only and
// focus returns to the trigger. Submenus open on hover, Right arrow or Enter, and a safe triangle keeps
// them open while the pointer travels toward them.
//
// A context menu marks what it acts on: the row (tr, [role=row], li or [data-menu-target]) under the
// right click, or under the finger of a long press, keeps a hover wash and an ink edge while its menu
// is open, so the person sees which row "Delete" will hit after the pointer has moved into the menu.
// onTargetChange hands that row to the caller, so the menu acts on the row the trigger marked, not on
// what the caller guessed from its own events. A click menu opened from a button inside such a row (the
// row's More button) marks the row the same way. Everything in a context menu also needs a visible
// path, usually that More button (trap/menu-only-path).

type Mode = 'click' | 'contextmenu';
type MenuState = {
  mode: Mode;
  /** Marks a row as the menu's target, or clears it with null. */
  mark: (row: HTMLElement | null) => void;
  /** The row under the last touch or pen press, for a long press that fires no contextmenu event. */
  pressed: React.RefObject<HTMLElement | null>;
};
const MenuContext = React.createContext<MenuState>({mode: 'click', mark: () => {}, pressed: {current: null}});

// The popup, rows, labels and rules are styles.css's menu-popup, menu-item, menu-label and menu-separator, the one list recipe
// that select, combobox, command and the other list popups share. The popup takes focus when a menu opens by keyboard with
// nothing highlighted, and menu-popup opts it out of the ring: the highlighted item is the focus indicator, not the edge.
const menuPopupClass = cn('menu-popup', overlaySurface, overlayMotion);

// A destructive item is written at rest (fail text) by menu-item and takes the fail wash, a row state, when highlighted.
const menuItemClass = 'group/menu-item menu-item data-inset:ps-8';

// Checkbox and radio items reserve the 32px leading column for their indicator.
const menuCheckItemClass = cn(menuItemClass, 'ps-8');

const menuLabelClass = 'menu-label data-inset:ps-8';
const menuSeparatorClass = 'menu-separator';
const menuShortcutClass = 'ms-auto ps-4';

type DropdownMenuProps = MenuPrimitive.Root.Props & {
  /** click: a trigger button opens it. contextmenu: a right click, long press or Shift+F10 on the trigger area opens it at the pointer. */
  trigger?: Mode;
  /** The row the menu acts on, when it opens on one, and null when it closes. Read the target here. */
  onTargetChange?: (row: HTMLElement | null) => void;
};

/** The row a context menu acts on, found from where it opened. */
const TARGET = '[data-menu-target], tr, [role="row"], li';

/** The row around `from` inside a context-menu area (`area`, or the nearest one), or null. */
function rowOf(from: EventTarget | null | undefined, area?: Element | null) {
  if (!(from instanceof Element)) return null;
  const row = from.closest<HTMLElement>(TARGET);
  const within = area ?? row?.closest('[data-menu-area]');
  return row && within && within.contains(row) && row !== within ? row : null;
}

function DropdownMenu({trigger = 'click', onOpenChange, onTargetChange, ...props}: DropdownMenuProps) {
  const target = React.useRef<HTMLElement | null>(null);
  const pressed = React.useRef<HTMLElement | null>(null);
  const onTarget = React.useRef(onTargetChange);
  React.useLayoutEffect(() => { onTarget.current = onTargetChange; });
  const mark = React.useCallback((row: HTMLElement | null) => {
    if (row === target.current) return;
    target.current?.removeAttribute('data-menu-target-open');
    target.current = row;
    row?.setAttribute('data-menu-target-open', '');
    onTarget.current?.(row);
  }, []);
  const state = React.useMemo(() => ({mode: trigger, mark, pressed}), [trigger, mark]);
  const change: MenuPrimitive.Root.Props['onOpenChange'] = (open, details) => {
    if (open && !target.current) {
      // A long press on touch opens the menu without a contextmenu event (iOS WebKit), so mark the row
      // the finger went down on. A click menu marks the row its button sits in.
      mark(trigger === 'contextmenu' ? pressed.current : rowOf(details.event?.target));
    }
    if (!open) { mark(null); pressed.current = null; }
    onOpenChange?.(open, details);
  };
  return <MenuContext.Provider value={state}>
    {trigger === 'contextmenu'
      ? <ContextMenuPrimitive.Root data-slot="dropdown-menu" onOpenChange={change as ContextMenuPrimitive.Root.Props['onOpenChange']} {...(props as ContextMenuPrimitive.Root.Props)}/>
      : <MenuPrimitive.Root data-slot="dropdown-menu" onOpenChange={change} {...props}/>}
  </MenuContext.Provider>;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  const container = useQuartzPortal();
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" container={container} {...props}/>;
}

type DropdownMenuTriggerProps = MenuPrimitive.Trigger.Props & {
  /**
   * Context menu only: keep text selection in the area. Off by default, so a long press on touch opens
   * the menu instead of selecting a word. Turn it on for a log or code people copy from.
   */
  selectable?: boolean;
};

function DropdownMenuTrigger({selectable = false, className, ...props}: DropdownMenuTriggerProps) {
  const {mode, mark, pressed} = React.useContext(MenuContext);
  if (mode === 'contextmenu') {
    const base = cn(
      !selectable && 'select-none',
      // The row the menu acts on: the hover wash between two frame lines, the selected-row look.
      '[&_[data-menu-target-open]]:bg-hover [&_[data-menu-target-open]]:shadow-[inset_0_1px_0_var(--line-frame),inset_0_-1px_0_var(--line-frame)]',
      'forced-colors:[&_[data-menu-target-open]]:outline-solid forced-colors:[&_[data-menu-target-open]]:outline-2 forced-colors:[&_[data-menu-target-open]]:-outline-offset-2',
    );
    return <ContextMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      data-menu-area=""
      data-selectable={selectable || undefined}
      onPointerDown={event => { if (event.pointerType !== 'mouse') pressed.current = rowOf(event.target, event.currentTarget); }}
      onContextMenu={event => { mark(rowOf(event.target, event.currentTarget)); }}
      onKeyDown={event => {
        // Shift+F10 opens the menu at the focused row, as the Menu key does natively: a contextmenu
        // event at the row's centre, which Base UI opens on and mark() reads.
        if (!(event.shiftKey && event.key === 'F10')) return;
        const from = document.activeElement as HTMLElement | null;
        if (!from || !event.currentTarget.contains(from)) return;
        event.preventDefault();
        const box = from.getBoundingClientRect();
        // Near the row's reading start: its left, or its right in right-to-left text.
        const inset = Math.min(box.width / 2, 160);
        const x = getComputedStyle(from).direction === 'rtl' ? box.right - inset : box.left + inset;
        from.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: x, clientY: box.top + box.height / 2, button: 2}));
      }}
      className={mergeClass(base, className as ContextMenuPrimitive.Trigger.Props['className'])}
      {...(props as ContextMenuPrimitive.Trigger.Props)}
    />;
  }
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" className={className} {...props}/>;
}

type DropdownMenuContentProps = MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset' | 'collisionPadding'>;

function DropdownMenuContent({align, alignOffset, side, sideOffset, collisionPadding = 8, className, ...props}: DropdownMenuContentProps) {
  const {mode} = React.useContext(MenuContext);
  // A click menu takes its name from its trigger; a context menu has no trigger button, so it needs
  // one. Pass the row's name ("Actions for run_8f2a"); "Actions" is the fallback.
  const popup = <MenuPrimitive.Popup data-slot="dropdown-menu-content" aria-label={mode === 'contextmenu' ? 'Actions' : undefined} className={mergeClass(menuPopupClass, className)} {...props}/>;
  return <DropdownMenuPortal>
    {mode === 'contextmenu'
      ? <ContextMenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align ?? 'start'} alignOffset={alignOffset ?? 4} side={side ?? 'inline-end'} sideOffset={sideOffset ?? 0} collisionPadding={collisionPadding}>{popup}</ContextMenuPrimitive.Positioner>
      : <MenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align ?? 'start'} alignOffset={alignOffset ?? 0} side={side ?? 'bottom'} sideOffset={sideOffset ?? 6} collisionPadding={collisionPadding}>{popup}</MenuPrimitive.Positioner>}
  </DropdownMenuPortal>;
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props}/>;
}

function DropdownMenuLabel({className, inset, ...props}: MenuPrimitive.GroupLabel.Props & {inset?: boolean}) {
  return <MenuPrimitive.GroupLabel data-slot="dropdown-menu-label" data-inset={inset || undefined} className={mergeClass(menuLabelClass, className)} {...props}/>;
}

type ItemVariant = 'default' | 'destructive';

function DropdownMenuItem({className, inset, variant = 'default', ...props}: MenuPrimitive.Item.Props & {inset?: boolean; variant?: ItemVariant}) {
  return <MenuPrimitive.Item
    data-slot="dropdown-menu-item"
    data-inset={inset || undefined}
    data-variant={variant}
    data-status={variant === 'destructive' ? 'fail' : undefined}
    className={mergeClass(menuItemClass, className)}
    {...props}
  />;
}

/** An item that navigates: a real link, so open in a new tab and copy link work (trap/menu-navigation). */
function DropdownMenuLinkItem({className, inset, ...props}: MenuPrimitive.LinkItem.Props & {inset?: boolean}) {
  return <MenuPrimitive.LinkItem
    data-slot="dropdown-menu-link-item"
    data-inset={inset || undefined}
    className={mergeClass([menuItemClass, 'cursor-pointer'], className)}
    {...props}
  />;
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props}/>;
}

function DropdownMenuSubTrigger({className, inset, children, ...props}: MenuPrimitive.SubmenuTrigger.Props & {inset?: boolean}) {
  return <MenuPrimitive.SubmenuTrigger
    data-slot="dropdown-menu-sub-trigger"
    data-inset={inset || undefined}
    className={mergeClass([menuItemClass, 'data-popup-open:bg-hover forced-colors:data-popup-open:outline-solid forced-colors:data-popup-open:outline-1 forced-colors:data-popup-open:-outline-offset-1'], className)}
    {...props}
  >
    {children}
    <Icon icon={ChevronRight} size={16} className="ms-auto text-text-3 rtl:-scale-x-100"/>
  </MenuPrimitive.SubmenuTrigger>;
}

function DropdownMenuSubContent({align = 'start', alignOffset = -4, side = 'inline-end', sideOffset = 2, className, collisionPadding = 8, ...props}: DropdownMenuContentProps) {
  // A submenu always positions against its parent item, whichever way the root opened.
  return <DropdownMenuPortal>
    <MenuPrimitive.Positioner className="isolate z-(--z-overlay) outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset} collisionPadding={collisionPadding}>
      <MenuPrimitive.Popup data-slot="dropdown-menu-sub-content" className={mergeClass(menuPopupClass, className)} {...props}/>
    </MenuPrimitive.Positioner>
  </DropdownMenuPortal>;
}

function DropdownMenuCheckboxItem({className, children, inset, ...props}: MenuPrimitive.CheckboxItem.Props & {inset?: boolean}) {
  return <MenuPrimitive.CheckboxItem
    data-slot="dropdown-menu-checkbox-item"
    data-inset={inset || undefined}
    className={mergeClass(menuCheckItemClass, className)}
    {...props}
  >
    <span data-slot="dropdown-menu-checkbox-item-indicator" className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
      <MenuPrimitive.CheckboxItemIndicator><Icon icon={Checkmark} size={16}/></MenuPrimitive.CheckboxItemIndicator>
    </span>
    {children}
  </MenuPrimitive.CheckboxItem>;
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props}/>;
}

function DropdownMenuRadioItem({className, children, inset, ...props}: MenuPrimitive.RadioItem.Props & {inset?: boolean}) {
  return <MenuPrimitive.RadioItem
    data-slot="dropdown-menu-radio-item"
    data-inset={inset || undefined}
    className={mergeClass(menuCheckItemClass, className)}
    {...props}
  >
    <span data-slot="dropdown-menu-radio-item-indicator" className="pointer-events-none absolute start-2 flex size-4 items-center justify-center">
      {/* The chosen option is a filled 8px square, the radio dot. */}
      <MenuPrimitive.RadioItemIndicator className="size-(--mark-size) bg-ink forced-colors:bg-[CanvasText]"/>
    </span>
    {children}
  </MenuPrimitive.RadioItem>;
}

function DropdownMenuSeparator({className, ...props}: MenuPrimitive.Separator.Props) {
  return <MenuPrimitive.Separator data-slot="dropdown-menu-separator" className={mergeClass(menuSeparatorClass, className)} {...props}/>;
}

/** The item's shortcut, as Kbd caps, from keys or from a string child. */
function DropdownMenuShortcut({className, keys, children, ...props}: React.ComponentProps<'kbd'> & {keys?: string[]}) {
  return <KbdGroup data-slot="dropdown-menu-shortcut" className={cn(menuShortcutClass, className)} {...props}>
    {keys ? keys.map((key, i) => <Kbd key={i}>{key}</Kbd>) : typeof children === 'string' ? <Kbd>{children}</Kbd> : children}
  </KbdGroup>;
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  menuPopupClass,
  menuItemClass,
  menuCheckItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
  type DropdownMenuProps,
};
