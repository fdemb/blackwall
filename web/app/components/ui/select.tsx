import {
  Select as RACSelect, SelectValue, ListBox, ListBoxItem, ListBoxSection, Header, composeRenderProps,
  type SelectProps as RACSelectProps, type ListBoxItemProps, type Key,
} from "react-aria-components";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Label } from "./field";
import { Popover } from "./popover";

export interface Option { id: string; label: string; icon?: React.ReactNode; description?: string }

export function SelectItem({ className, children, ...props }: ListBoxItemProps & { children: React.ReactNode }) {
  return (
    <ListBoxItem
      {...props}
      textValue={props.textValue ?? (typeof children === "string" ? children : undefined)}
      className={composeRenderProps(className, (c) =>
        cn("flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none focus:bg-accent focus:text-accent-foreground disabled:opacity-50", c),
      )}
    >
      {composeRenderProps(children, (children, { isSelected }) => (
        <>
          <span className="flex flex-1 items-center gap-2 truncate">{children}</span>
          <span className="w-4">{isSelected && <Check className="size-3.5 text-primary" />}</span>
        </>
      ))}
    </ListBoxItem>
  );
}

interface SelectProps extends Omit<RACSelectProps<Option>, "children"> {
  label?: string;
  options: Option[];
  placeholder?: string;
  triggerClassName?: string;
  /** Renders as a borderless chip for use in property rows. */
  variant?: "field" | "ghost";
}

export function Select({ label, options, placeholder, className, triggerClassName, variant = "field", ...props }: SelectProps) {
  return (
    <RACSelect {...props} className={composeRenderProps(className, (c) => cn("flex min-w-0 flex-col", c))}>
      {label && <Label>{label}</Label>}
      <Button
        variant={variant === "ghost" ? "ghost" : "secondary"}
        className={cn("w-full justify-between gap-2 font-normal", variant === "ghost" ? "h-7 justify-start px-2 text-foreground" : "h-8 px-2.5", triggerClassName)}
      >
        <SelectValue className="flex min-w-0 flex-1 items-center gap-2 truncate text-left data-[placeholder]:text-muted-foreground" >
          {({ selectedText, isPlaceholder }) => (isPlaceholder ? placeholder ?? "" : <SelectedOption options={options} text={selectedText} />)}
        </SelectValue>
        {variant === "field" && <ChevronsUpDown className="size-3.5 text-muted-foreground" />}
      </Button>
      <Popover placement="bottom start" className="min-w-48">
        <ListBox items={options} className="max-h-72 overflow-auto p-1 outline-none">
          {(o) => (
            <SelectItem id={o.id} textValue={o.label}>
              {o.icon}
              <span className="truncate">{o.label}</span>
            </SelectItem>
          )}
        </ListBox>
      </Popover>
    </RACSelect>
  );
}

function SelectedOption({ options, text }: { options: Option[]; text: string | null }) {
  const o = options.find((o) => o.label === text);
  return (
    <>
      {o?.icon}
      <span className="truncate">{text}</span>
    </>
  );
}
export { ListBox, ListBoxItem, ListBoxSection, Header, type Key };
