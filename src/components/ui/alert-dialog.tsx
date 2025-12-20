import { AlertDialog as AlertDialogPrimitive } from "@kobalte/core/alert-dialog";
import { useDialogContext } from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { VariantProps } from "class-variance-authority";
import type { ComponentProps, ValidComponent } from "solid-js";
import * as Solid from "solid-js";

import { Button, type buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function AlertDialog(props: ComponentProps<typeof AlertDialogPrimitive>) {
  return <AlertDialogPrimitive data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger<T extends ValidComponent = "button">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.Trigger<T>>
  >,
) {
  return (
    <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />
  );
}

function AlertDialogPortal(
  props: ComponentProps<typeof AlertDialogPrimitive.Portal>,
) {
  return (
    <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />
  );
}

function AlertDialogOverlay<T extends ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.Overlay<T>>
  >,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof AlertDialogPrimitive.Overlay>,
    ["class"],
  );

  return (
    <AlertDialogPrimitive.Overlay
      data-slot="alert-dialog-overlay"
      class={cn(
        "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 bg-black/10 duration-100 supports-[backdrop-filter]:backdrop-blur-xs fixed inset-0 isolate z-50",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogContent<T extends ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.Content<T>> & {
      size?: "default" | "sm";
    }
  >,
) {
  const mergedProps = Solid.mergeProps({ size: "default" as const }, props);
  const [local, rest] = Solid.splitProps(
    mergedProps as ComponentProps<typeof AlertDialogPrimitive.Content> & {
      size?: "default" | "sm";
    },
    ["class", "size"],
  );

  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Content
        data-slot="alert-dialog-content"
        data-size={local.size}
        class={cn(
          "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 bg-background ring-foreground/10 gap-4 rounded-xl p-4 ring-1 duration-100 data-[size=default]:max-w-xs data-[size=sm]:max-w-xs data-[size=default]:sm:max-w-sm group/alert-dialog-content fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 outline-none",
          local.class,
        )}
        {...rest}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="alert-dialog-header"
      class={cn(
        "grid grid-rows-[auto_1fr] place-items-center gap-1.5 text-center has-[[data-slot=alert-dialog-media]]:grid-rows-[auto_auto_1fr] has-[[data-slot=alert-dialog-media]]:gap-x-4 sm:group-data-[size=default]/alert-dialog-content:place-items-start sm:group-data-[size=default]/alert-dialog-content:text-left sm:group-data-[size=default]/alert-dialog-content:has-[[data-slot=alert-dialog-media]]:grid-rows-[auto_1fr]",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogFooter<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="alert-dialog-footer"
      class={cn(
        "bg-muted/50 -mx-4 -mb-4 rounded-b-xl border-t p-4 flex flex-col-reverse gap-2 group-data-[size=sm]/alert-dialog-content:grid group-data-[size=sm]/alert-dialog-content:grid-cols-2 sm:flex-row sm:justify-end",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogMedia<T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ComponentProps<"div">>,
) {
  const [local, rest] = Solid.splitProps(props as ComponentProps<"div">, [
    "class",
  ]);

  return (
    <div
      data-slot="alert-dialog-media"
      class={cn(
        "bg-muted mb-2 inline-flex size-10 items-center justify-center rounded-md sm:group-data-[size=default]/alert-dialog-content:row-span-2 *:[svg:not([class*='size-'])]:size-6",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogTitle<T extends ValidComponent = "h2">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.Title<T>>
  >,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof AlertDialogPrimitive.Title>,
    ["class"],
  );

  return (
    <AlertDialogPrimitive.Title
      data-slot="alert-dialog-title"
      class={cn(
        "text-sm font-medium sm:group-data-[size=default]/alert-dialog-content:group-has-[[data-slot=alert-dialog-media]]/alert-dialog-content:col-start-2",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogDescription<T extends ValidComponent = "p">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.Description<T>>
  >,
) {
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof AlertDialogPrimitive.Description>,
    ["class"],
  );

  return (
    <AlertDialogPrimitive.Description
      data-slot="alert-dialog-description"
      class={cn(
        "text-muted-foreground *:[a]:hover:text-foreground text-sm text-balance md:text-pretty *:[a]:underline *:[a]:underline-offset-3",
        local.class,
      )}
      {...rest}
    />
  );
}

function AlertDialogAction<T extends ValidComponent = "button">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof Button<T>> & {
      action?: () => Promise<unknown>;
    }
  >,
) {
  const context = useDialogContext();
  const [pending, setPending] = Solid.createSignal(false);
  const [local, rest] = Solid.splitProps(
    props as ComponentProps<typeof Button> & {
      action?: () => Promise<unknown>;
    },
    ["class", "onClick", "action"],
  );

  const handleClick = async (e: MouseEvent) => {
    if (local.action) {
      setPending(true);
      try {
        await local.action();
        context.close();
      } catch {
        // Don't close the dialog on error
      } finally {
        setPending(false);
      }
    } else {
      if (typeof local.onClick === "function") {
        (local.onClick as (e: MouseEvent) => void)(e);
      }
      context.close();
    }
  };

  return (
    <Button
      data-slot="alert-dialog-action"
      class={cn(local.class)}
      onClick={handleClick}
      disabled={pending()}
      {...rest}
    />
  );
}

function AlertDialogCancel<T extends ValidComponent = "button">(
  props: PolymorphicProps<
    T,
    ComponentProps<typeof AlertDialogPrimitive.CloseButton<T>> &
      VariantProps<typeof buttonVariants>
  >,
) {
  const mergedProps = Solid.mergeProps(
    { variant: "outline" as const, size: "default" as const },
    props,
  );
  const [local, rest] = Solid.splitProps(
    mergedProps as ComponentProps<typeof AlertDialogPrimitive.CloseButton> &
      VariantProps<typeof buttonVariants>,
    ["class", "variant", "size"],
  );

  return (
    <AlertDialogPrimitive.CloseButton
      as={(closeButtonProps: ComponentProps<typeof Button>) => (
        <Button
          {...closeButtonProps}
          variant={local.variant}
          size={local.size}
        />
      )}
      data-slot="alert-dialog-cancel"
      class={cn(local.class)}
      {...rest}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
