import {
  Dialog as DialogPrimitive,
  type DialogTriggerProps,
} from "@kobalte/core/dialog";
import XIcon from "lucide-solid/icons/x";
import * as Solid from "solid-js";

import { cn } from "@/lib/utils";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { ComponentProps, ValidComponent } from "solid-js";

function Dialog(props: ComponentProps<typeof DialogPrimitive>) {
  return <DialogPrimitive data-slot="dialog" {...props} />;
}

function DialogTrigger<T extends ValidComponent = "button">(
  props: PolymorphicProps<T, DialogTriggerProps<T>>,
) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose(
  props: ComponentProps<typeof DialogPrimitive.CloseButton>,
) {
  return <DialogPrimitive.CloseButton data-slot="dialog-close" {...props} />;
}

function DialogOverlay<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<typeof DialogPrimitive.Overlay<T>>>,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof DialogPrimitive.Overlay>,
    ["class"],
  );

  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      class={cn(
        "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        local.class,
      )}
      {...rest}
    />
  );
}

function DialogContent<T extends ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof DialogPrimitive.Content<T>> & {
      showCloseButton?: boolean;
    }
  >,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof DialogPrimitive.Content> & {
      showCloseButton?: boolean;
    },
    ["class", "children", "showCloseButton"],
  );

  const showCloseButton = () => local.showCloseButton ?? true;

  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        class={cn(
          "bg-background data-[expanded]:animate-in squircle-lg data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-lg duration-200 sm:max-w-lg",
          local.class,
        )}
        {...rest}
      >
        {local.children}
        <Solid.Show when={showCloseButton()}>
          <DialogPrimitive.CloseButton
            data-slot="dialog-close"
            class="ring-offset-background focus:ring-ring data-[expanded]:bg-accent data-[expanded]:text-muted-foreground absolute top-4 right-4 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span class="sr-only">Close</span>
          </DialogPrimitive.CloseButton>
        </Solid.Show>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="dialog-header"
      class={cn("flex flex-col gap-2 text-center sm:text-left", local.class)}
      {...rest}
    />
  );
}

function DialogSingleLineHeader<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="dialog-single-line-header"
      class={cn(
        "py-2 pl-4 pr-2 flex flex-row justify-between items-center",
        local.class,
      )}
      {...rest}
    />
  );
}

function DialogFooter<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="dialog-footer"
      class={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        local.class,
      )}
      {...rest}
    />
  );
}

function DialogTitle<T extends ValidComponent = "h2">(
  props: PolymorphicProps<T, ComponentProps<typeof DialogPrimitive.Title<T>>>,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof DialogPrimitive.Title>,
    ["class"],
  );

  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      class={cn("text-lg leading-none font-semibold", local.class)}
      {...rest}
    />
  );
}

function DialogDescription<T extends ValidComponent = "p">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof DialogPrimitive.Description<T>>
  >,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof DialogPrimitive.Description>,
    ["class"],
  );

  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      class={cn("text-muted-foreground text-sm", local.class)}
      {...rest}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogSingleLineHeader,
  DialogTitle,
  DialogTrigger,
};
