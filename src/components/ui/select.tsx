import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown } from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

export type SelectOption = { value: string; label: string; disabled?: boolean; icon?: ComponentType<{ className?: string }> };

type SelectProps = {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  className?: string;
  triggerClassName?: string;
  popupClassName?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  align?: 'start' | 'center' | 'end';
};

export function Select({ id, value, options, onValueChange, className, triggerClassName, popupClassName, disabled, align = 'start', ...aria }: SelectProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => { if (next !== null) onValueChange(String(next)); }} items={options.map(({ value: optionValue, label }) => ({ value: optionValue, label }))}>
      <SelectPrimitive.Trigger
        id={id}
        disabled={disabled}
        className={cn(
          'inline-flex min-h-8 min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left text-sm text-foreground shadow-xs outline-none transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-accent/50',
          className,
          triggerClassName,
        )}
        {...aria}
      >
        <SelectPrimitive.Value className="min-w-0 flex-1 truncate" />
        <SelectPrimitive.Icon className="shrink-0 text-muted-foreground"><ChevronDown className="size-3.5" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={4} align={align} className="z-50 outline-none">
          <SelectPrimitive.Popup className={cn(
            'max-h-[min(20rem,var(--available-height))] min-w-[var(--anchor-width)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg outline-none transition-[opacity,transform] duration-100 data-[starting-style]:scale-[.98] data-[starting-style]:opacity-0 data-[ending-style]:scale-[.98] data-[ending-style]:opacity-0',
            popupClassName,
          )}>
            <SelectPrimitive.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain">
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[selected]:font-medium data-[disabled]:pointer-events-none data-[disabled]:opacity-45"
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{option.icon && <option.icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}{option.label}</span>
                  <SelectPrimitive.ItemIndicator className="flex size-4 shrink-0 items-center justify-center"><Check className="size-3.5" /></SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
