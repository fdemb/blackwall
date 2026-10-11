import {
  Menu as RACMenu,
  MenuItem as RACMenuItem,
  MenuTrigger,
  SubmenuTrigger,
  Separator,
  Header,
  MenuSection,
  composeRenderProps,
  type MenuProps,
  type MenuItemProps,
} from "react-aria-components";
import { Check } from "lucide-react";
import { cn } from "~/lib/utils";
import { Popover } from "./popover";

export { MenuTrigger, SubmenuTrigger, MenuSection, Header };

export function Menu<T extends object>({ className, ...props }: MenuProps<T>) {
  return (
    <RACMenu
      {...props}
      className={composeRenderProps(className, (c) =>
        cn("max-h-80 min-w-44 overflow-auto overscroll-contain p-1 outline-none", c),
      )}
    />
  );
}
export function MenuPopover({ children, ...props }: React.ComponentProps<typeof Popover>) {
  return <Popover {...props}>{children}</Popover>;
}
export function MenuItem({ className, children, ...props }: MenuItemProps) {
  return (
    <RACMenuItem
      {...props}
      className={composeRenderProps(className, (c, { isDisabled }) =>
        cn(
          "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5  outline-none focus:bg-accent focus:text-accent-foreground",
          isDisabled && "opacity-50",
          props.id === "delete" || props.id === "destructive"
            ? "text-destructive focus:bg-destructive/10 focus:text-destructive"
            : "",
          "[&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
          c,
        ),
      )}
    >
      {composeRenderProps(children, (children, { selectionMode, isSelected }) => (
        <>
          {children}
          {selectionMode !== "none" && (
            <span className="ml-auto w-4">
              {isSelected && <Check aria-hidden="true" className="size-3.5 text-primary" />}
            </span>
          )}
        </>
      ))}
    </RACMenuItem>
  );
}
export function MenuSeparator() {
  return <Separator className="-mx-1 my-1 h-px bg-border" />;
}
