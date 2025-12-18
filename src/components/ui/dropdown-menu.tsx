import { DropdownMenu as DropdownMenuPrimitive } from "@kobalte/core/dropdown-menu";
import CheckIcon from "lucide-solid/icons/check";
import ChevronRightIcon from "lucide-solid/icons/chevron-down";
import CircleIcon from "lucide-solid/icons/circle";
import * as Solid from "solid-js";

import { cn } from "@/lib/utils";

function DropdownMenu(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive>,
) {
  return <DropdownMenuPrimitive data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Portal>,
) {
  return (
    <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
  );
}

function DropdownMenuTrigger(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
  return (
    <DropdownMenuPrimitive.Trigger
      data-slot="dropdown-menu-trigger"
      {...props}
    />
  );
}

function DropdownMenuContent(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Content>,
) {
  const mergedProps = Solid.mergeProps(
    {
      sideOffset: 4,
    },
    props,
  );
  const [local, rest] = Solid.splitProps(mergedProps, ["class", "sideOffset"]);

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={local.sideOffset}
        class={cn(
          "bg-popover text-popover-foreground rounded-lg data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto border p-1 shadow-md",
          local.class,
        )}
        {...rest}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuGroup(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Group>,
) {
  return (
    <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
  );
}

function DropdownMenuItem(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
  },
) {
  const mergedProps = Solid.mergeProps(
    {
      variant: "default",
    },
    props,
  );

  const [local, rest] = Solid.splitProps(mergedProps, [
    "inset",
    "variant",
    "class",
  ]);

  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={local.inset}
      data-variant={local.variant}
      class={cn(
        "focus:bg-accent focus:text-accent-foreground rounded-md data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class,
      )}
      {...rest}
    />
  );
}

function DropdownMenuCheckboxItem(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>,
) {
  const [local, rest] = Solid.splitProps(props, [
    "class",
    "children",
    "checked",
  ]);

  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      class={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class,
      )}
      checked={local.checked}
      {...rest}
    >
      <span class="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon class="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {local.children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>,
) {
  return (
    <DropdownMenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  );
}

function DropdownMenuRadioItem(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>,
) {
  const [local, rest] = Solid.splitProps(props, ["class", "children"]);

  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      class={cn(
        "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class,
      )}
      {...rest}
    >
      <span class="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon class="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {local.children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuGroupLabel(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.GroupLabel> & {
    inset?: boolean;
  },
) {
  const [local, rest] = Solid.splitProps(props, ["class", "inset"]);

  return (
    <DropdownMenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={local.inset}
      class={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        local.class,
      )}
      {...rest}
    />
  );
}

function DropdownMenuItemLabel(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.ItemLabel> & {
    inset?: boolean;
  },
) {
  const [local, rest] = Solid.splitProps(props, ["class", "inset"]);

  return (
    <DropdownMenuPrimitive.ItemLabel
      data-slot="dropdown-menu-label"
      data-inset={local.inset}
      class={cn(
        "px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
        local.class,
      )}
      {...rest}
    />
  );
}

function DropdownMenuSeparator(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Separator>,
) {
  const [local, rest] = Solid.splitProps(props, ["class"]);

  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      class={cn("bg-border -mx-1 my-1 h-px", local.class)}
      {...rest}
    />
  );
}

function DropdownMenuShortcut(props: Solid.ComponentProps<"span">) {
  const [local, rest] = Solid.splitProps(props, ["class"]);
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      class={cn(
        "text-muted-foreground ml-auto text-xs tracking-widest",
        local.class,
      )}
      {...rest}
    />
  );
}

function DropdownMenuSub(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.Sub>,
) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
  },
) {
  const [local, rest] = Solid.splitProps(props, ["class", "inset", "children"]);
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={local.inset}
      class={cn(
        "focus:bg-accent focus:text-accent-foreground data-[expanded]:bg-accent data-[expanded]:text-accent-foreground flex cursor-default items-center px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8",
        local.class,
      )}
      {...rest}
    >
      {local.children}
      <ChevronRightIcon class="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent(
  props: Solid.ComponentProps<typeof DropdownMenuPrimitive.SubContent>,
) {
  const [local, rest] = Solid.splitProps(props, ["class"]);
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      class={cn(
        "bg-popover text-popover-foreground data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden border p-1 shadow-lg",
        local.class,
      )}
      {...rest}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
