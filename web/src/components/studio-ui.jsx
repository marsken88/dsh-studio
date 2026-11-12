// Adapters that let the legacy panel (client.js, plain React.createElement) use
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
// real shadcn/ui primitives without rewriting its markup.
//
// Every adapter keeps the legacy prop contract, so client.js can do:
//     const Sheet = UIKIT?.SheetDrawer ?? LegacySideDrawer
// and fall back safely when the kit is missing.
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import * as ProgressPrimitive from '@radix-ui/react-progress'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '../lib/utils.js'
import { portalRoot } from '../lib/portal.js'
import { Button, Input, Label, Textarea, Badge, Tabs, TabsList, TabsTrigger } from './ui.jsx'

const TooltipProvider = TooltipPrimitive.Provider


/* ------------------------------------------------------------------ Sheet ---
   Right-side editor drawer: same API as the legacy SideDrawer
   ({ title, hint, onClose, footer, children }) but backed by Radix Dialog, so
   it gets focus trapping, Esc handling, scroll lock and aria wiring for free. */
export function SheetDrawer({ title, hint, onClose, footer, children }) {
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal container={portalRoot()}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[95] bg-black/45 backdrop-blur-[1px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed right-0 top-0 z-[96] flex h-full w-[min(760px,96vw)] flex-col border-l border-border bg-card text-card-foreground shadow-[0_0_60px_rgba(0,0,0,.35)] outline-none"
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-[15px] font-semibold leading-tight">{title}</DialogPrimitive.Title>
              {hint ? <div className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</div> : null}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[12px]">
                <X className="mr-1 h-3.5 w-3.5" />
                关闭
              </Button>
            </DialogPrimitive.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer ? <div className="shrink-0 border-t border-border px-5 py-3">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

/* ------------------------------------------------------------- Tabs bar ---
   { items: [{ id, label }], value, onChange }  → shadcn Tabs (Radix) */
/* --------------------------------------------------------------- Tabs ----
   { items: [{ id, label, count?, hint? }], value, onChange } */

function Hint({ label, children }) {
  if (label === undefined || label === null || label === '') return children
  return (
    <TooltipProvider delayDuration={260}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal container={portalRoot()}>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-[120] max-w-[240px] rounded-md border border-border bg-card px-2 py-1 text-[11.5px] leading-[1.45] text-foreground shadow-md"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  )
}

export function TabsBar({ items, value, onChange, className }) {
  return (
    <Tabs value={value} onValueChange={onChange} className={cn('min-w-0', className)}>
      <TabsList>
        {items.map((item) => (
          <Hint key={item.id} label={item.hint}>
            <TabsTrigger
              value={item.id}
            >
              {item.label}
              {item.count === undefined || item.count === null || item.count === '' ? null : (
                <span className="ml-1 rounded-[4px] bg-foreground/8 px-1 text-[10.5px] font-medium tabular-nums text-muted-foreground">
                  {String(item.count)}
                </span>
              )}
            </TabsTrigger>
          </Hint>
        ))}
      </TabsList>
    </Tabs>
  )
}

export function SegGroup({ value, onChange, options, className }) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next)}
      className={cn('inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5', className)}
    >
      {options.map((opt) => (
        <ToggleGroupPrimitive.Item
          key={opt.id}
          value={opt.id}
          aria-label={opt.label}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11.5px] text-muted-foreground transition hover:text-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-sm"
        >
          {opt.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

/* --------------------------------------------------------------- Select ---
   { value, onChange, options: [{ value, label }], placeholder, id, disabled } */
export function SelectBox({ value, onChange, options, placeholder = '请选择', id, disabled, className, style }) {
  return (
    <SelectPrimitive.Root value={value === '' || value === undefined ? undefined : String(value)} onValueChange={onChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        style={style}
        className={cn(
          'flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-sm whitespace-nowrap shadow-sm transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground [&_svg:not([class*=text-])]:text-muted-foreground dark:hover:bg-input/50',
          className,
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal container={portalRoot()}>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="relative z-[120] max-h-[280px] min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={String(option.value)}
                value={String(option.value)}
                className="relative flex w-full cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              >
                <SelectPrimitive.ItemIndicator className="absolute left-1.5 flex items-center">
                  <Check className="h-3.5 w-3.5" />
                </SelectPrimitive.ItemIndicator>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}

/* --------------------------------------------------------------- Switch ---
   Boolean row: { checked, onChange, label, hint, disabled } */
export function SwitchBox({ checked, onChange, label, hint, disabled, bare = false }) {
  const control = (
    <SwitchPrimitive.Root
      checked={checked === true}
      onCheckedChange={(next) => onChange(next)}
      disabled={disabled}
      className="h-5 w-9 shrink-0 rounded-full border border-transparent bg-input transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-card shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  )
  if (bare === true || (label === undefined && hint === undefined)) return control
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <div className="text-[12.5px] leading-snug">{label}</div>
        {hint ? <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="mt-0.5">{control}</div>
    </div>
  )
}

/* ------------------------------------------------------ tooltip wrapper --- */
export function Tip({ label, children }) {
  if (!label) return children
  return (
    <TooltipProvider delayDuration={250}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal container={portalRoot()}>
          <TooltipPrimitive.Content
            sideOffset={6}
            className="z-[130] max-w-[280px] rounded-md bg-primary px-2 py-1 text-[11.5px] leading-snug text-primary-foreground shadow"
          >
            {label}
            <TooltipPrimitive.Arrow className="fill-primary" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipProvider>
  )
}

/* ------------------------------------------------------------- progress --- */
export function ProgressBar({ value, tone, className }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0))
  const color = tone === 'over' ? 'bg-destructive' : tone === 'warn' ? 'bg-amber-500' : 'bg-primary'
  return (
    <ProgressPrimitive.Root className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)} value={pct}>
      <ProgressPrimitive.Indicator className={'h-full w-full transition-transform ' + color} style={{ transform: `translateX(-${100 - pct}%)` }} />
    </ProgressPrimitive.Root>
  )
}

export { Button, Input, Textarea, Label, Badge }


/* ----------------------------------------------------------------- dialogs ---
   Centered confirm / input dialog. The legacy panel used window.confirm and
   window.prompt, which drop the browser's own chrome into a shadcn-styled app.
   DialogBox keeps the same decision flow (resolve with true/false or text) but
   renders as a proper modal with focus trap, Esc and aria wiring. */
export function DialogBox({
  open,
  title,
  message,
  danger = false,
  okText = '确定',
  cancelText = '取消',
  input = false,
  value = '',
  placeholder = '',
  onChange,
  onOk,
  onCancel,
}) {
  return (
    <DialogPrimitive.Root open={open === true} onOpenChange={(next) => { if (!next) onCancel() }}>
      <DialogPrimitive.Portal container={portalRoot()}>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[95] bg-black/55 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[96] w-[min(440px,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-4 text-card-foreground shadow-xl">
          <DialogPrimitive.Title className="text-[13px] font-semibold leading-snug">{title}</DialogPrimitive.Title>
          {message ? (
            <DialogPrimitive.Description className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">
              {message}
            </DialogPrimitive.Description>
          ) : null}
          {input ? (
            <textarea
              autoFocus
              rows={3}
              value={value}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
              className="mt-3 box-border w-full min-w-0 resize-y rounded-md border border-input bg-card px-2.5 py-2 text-[12.5px] leading-relaxed focus:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
            />
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onCancel}>{cancelText}</Button>
            <Button variant={danger ? 'destructive' : 'default'} size="sm" onClick={onOk}>{okText}</Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
