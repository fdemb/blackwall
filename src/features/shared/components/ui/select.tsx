import { cn } from "@/lib/utils";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { Select as SelectPrimitive } from "@kobalte/core/select";
import CheckIcon from "lucide-solid/icons/check";
import ChevronDownIcon from "lucide-solid/icons/chevron-down";
import * as Solid from "solid-js";
import { labelClasses } from "./label";

const Select = <
  TOption extends unknown = string,
  T extends Solid.ValidComponent = "div",
>(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive<TOption, never, T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive>,
    ["class"],
  );

  return (
    <SelectPrimitive
      data-slot="select"
      class={cn("flex flex-col gap-2 ", local.class)}
      {...rest}
    />
  );
};

const SelectValue = <
  TOption extends unknown = string,
  T extends Solid.ValidComponent = "span",
>(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Value<TOption, T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Value>,
    ["class"],
  );

  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      class={cn("data-[placeholder-shown]:text-muted-foreground", local.class)}
      {...rest}
    />
  );
};

const SelectTrigger = <T extends Solid.ValidComponent = "button">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Trigger<T>> & {
      size?: "sm" | "default";
    }
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Trigger> & {
      size?: "sm" | "default";
    },
    ["class", "size", "children"],
  );

  const size = () => local.size || "default";

  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size()}
      class={cn(
        "border-input w-full [&_svg:not([class*='text-'])]:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 dark:hover:bg-input/50 flex items-center justify-between gap-2 border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        local.class,
      )}
      {...rest}
    >
      {local.children}
      <SelectPrimitive.Icon>
        <ChevronDownIcon class="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
};

const SelectContent = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Content<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Content>,
    ["class", "children"],
  );

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        class={cn(
          "bg-popover text-popover-foreground data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 relative z-50 max-h-(--kobalte-select-content-available-height) min-w-[8rem] origin-(--kobalte-select-content-transform-origin) overflow-x-hidden overflow-y-auto border shadow-md p-1",
          local.class,
        )}
        {...rest}
      >
        {local.children}
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
};

const SelectLabel = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Label<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Label>,
    ["class"],
  );

  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      class={cn(labelClasses, local.class)}
      {...rest}
    />
  );
};

const SelectItem = <T extends Solid.ValidComponent = "li">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Item<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Item>,
    ["class", "children"],
  );

  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      class={cn(
        "focus:bg-accent focus:text-accent-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex w-full cursor-default items-center gap-2 py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        local.class,
      )}
      {...rest}
    >
      <SelectPrimitive.ItemIndicator class="absolute right-2 flex size-3.5 items-center justify-center">
        <CheckIcon class="size-4" />
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemLabel>{local.children}</SelectPrimitive.ItemLabel>
    </SelectPrimitive.Item>
  );
};

const SelectDescription = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Description<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Description>,
    ["class"],
  );

  return (
    <SelectPrimitive.Description
      data-slot="select-description"
      class={cn("text-muted-foreground text-sm", local.class)}
      {...rest}
    />
  );
};

const SelectErrorMessage = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.ErrorMessage<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.ErrorMessage>,
    ["class"],
  );

  return (
    <SelectPrimitive.ErrorMessage
      data-slot="select-error-message"
      class={cn("text-destructive text-sm", local.class)}
      {...rest}
    />
  );
};

const SelectIcon = <T extends Solid.ValidComponent = "span">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Icon<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Icon>,
    ["class"],
  );

  return (
    <SelectPrimitive.Icon
      data-slot="select-icon"
      class={local.class}
      {...rest}
    />
  );
};

const SelectListbox = <T extends Solid.ValidComponent = "ul">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Listbox<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Listbox>,
    ["class"],
  );

  return (
    <SelectPrimitive.Listbox
      data-slot="select-listbox"
      class={local.class}
      {...rest}
    />
  );
};

const SelectSection = <T extends Solid.ValidComponent = "li">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Section<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Section>,
    ["class"],
  );

  return (
    <SelectPrimitive.Section
      data-slot="select-section"
      class={cn(
        "text-muted-foreground px-2 py-1.5 text-xs font-semibold",
        local.class,
      )}
      {...rest}
    />
  );
};

const SelectItemLabel = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.ItemLabel<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.ItemLabel>,
    ["class"],
  );

  return (
    <SelectPrimitive.ItemLabel
      data-slot="select-item-label"
      class={local.class}
      {...rest}
    />
  );
};

const SelectItemDescription = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.ItemDescription<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.ItemDescription>,
    ["class"],
  );

  return (
    <SelectPrimitive.ItemDescription
      data-slot="select-item-description"
      class={cn("text-muted-foreground text-sm", local.class)}
      {...rest}
    />
  );
};

const SelectItemIndicator = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.ItemIndicator<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.ItemIndicator>,
    ["class"],
  );

  return (
    <SelectPrimitive.ItemIndicator
      data-slot="select-item-indicator"
      class={local.class}
      {...rest}
    />
  );
};

const SelectArrow = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof SelectPrimitive.Arrow<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof SelectPrimitive.Arrow>,
    ["class"],
  );

  return (
    <SelectPrimitive.Arrow
      data-slot="select-arrow"
      class={local.class}
      {...rest}
    />
  );
};

const SelectHiddenSelect = (
  props: Solid.ComponentProps<typeof SelectPrimitive.HiddenSelect>,
) => {
  return <SelectPrimitive.HiddenSelect {...props} />;
};

Select.Value = SelectValue;
Select.Trigger = SelectTrigger;
Select.Content = SelectContent;
Select.Item = SelectItem;
Select.Label = SelectLabel;
Select.Description = SelectDescription;
Select.ErrorMessage = SelectErrorMessage;
Select.Icon = SelectIcon;
Select.Listbox = SelectListbox;
Select.Section = SelectSection;
Select.ItemLabel = SelectItemLabel;
Select.ItemDescription = SelectItemDescription;
Select.ItemIndicator = SelectItemIndicator;
Select.Arrow = SelectArrow;
Select.HiddenSelect = SelectHiddenSelect;

type FullSelectOption = {
  label: string;
  value: string;
};

type FullSelectProps = {
  name: string;
  label?: string | undefined;
  placeholder?: string | undefined;
  options: FullSelectOption[];
  value: string | undefined;
  error: string;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  ref: (element: HTMLSelectElement) => void;
  onInput: Solid.JSX.EventHandler<HTMLSelectElement, InputEvent>;
  onChange: Solid.JSX.EventHandler<HTMLSelectElement, Event>;
  onBlur: Solid.JSX.EventHandler<HTMLSelectElement, FocusEvent>;
};

function FullSelect(props: FullSelectProps) {
  const [rootProps, selectProps] = Solid.splitProps(
    props,
    ["name", "placeholder", "options", "required", "disabled"],
    ["placeholder", "ref", "onInput", "onChange", "onBlur"],
  );
  const [getValue, setValue] = Solid.createSignal<FullSelectOption>();
  Solid.createEffect(() => {
    setValue(props.options.find((option) => props.value === option.value));
  });
  return (
    <Select
      {...rootProps}
      multiple={false}
      value={getValue()}
      onChange={setValue}
      optionValue="value"
      optionTextValue="label"
      validationState={props.error ? "invalid" : "valid"}
      itemComponent={(props) => (
        <Select.Item item={props.item}>
          <Select.ItemLabel>{props.item.textValue}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Solid.Show when={props.label}>
        <Select.Label>{props.label}</Select.Label>
      </Solid.Show>
      <Select.HiddenSelect {...selectProps} />
      <Select.Trigger>
        <Select.Value<FullSelectOption>>
          {(state) => state.selectedOption().label}
        </Select.Value>
      </Select.Trigger>
      <Select.Content />
      <Select.ErrorMessage>{props.error}</Select.ErrorMessage>
    </Select>
  );
}

export { FullSelect, Select };
