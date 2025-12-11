import { cn } from "@/lib/utils";
import { Checkbox as CheckboxPrimitive } from "@kobalte/core/checkbox";
import CheckIcon from "lucide-solid/icons/check";
import { type ComponentProps, splitProps } from "solid-js";

function Checkbox(props: ComponentProps<typeof CheckboxPrimitive>) {
  const [local, rest] = splitProps(props, ["class"]);
  return (
    <CheckboxPrimitive
      class={cn("inline-flex items-center checkbox__root", local.class)}
      {...rest}
    >
      <CheckboxPrimitive.Input class="checkbox__input" />
      <CheckboxPrimitive.Control class="size-5 rounded-md border border-border bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground">
        <CheckboxPrimitive.Indicator class="flex items-center justify-center size-full">
          <CheckIcon class="size-4" />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Control>
    </CheckboxPrimitive>
  );
}

export { Checkbox };
