import { createContext, use, useEffect, useState } from "react";
import {
  Modal,
  ModalOverlay,
  Dialog as RACDialog,
  Heading,
  DialogTrigger,
  composeRenderProps,
  type ModalOverlayProps,
} from "react-aria-components";
import { X } from "lucide-react";
import { cn } from "~/lib/utils";
import { useI18n } from "~/lib/i18n";
import { Button, type ButtonProps } from "./button";

export { DialogTrigger, Heading };

const DirtyCtx = createContext<(dirty: boolean) => void>(() => {});

/**
 * Forms call this with "has the person typed anything". While true, clicking the backdrop or pressing
 * Escape no longer dismisses the dialog, so a stray click can't throw the draft away. The Cancel and
 * close buttons still work.
 */
export function useDialogDirty(dirty: boolean) {
  const set = use(DirtyCtx);
  useEffect(() => {
    set(dirty);
    return () => set(false);
  }, [dirty, set]);
}

interface DialogProps extends Omit<ModalOverlayProps, "children"> {
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  position?: "center" | "top";
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  // Kept for compat. Prefer composing <DialogClose /> wherever the default slot doesn't fit.
  hideClose?: boolean;
}

const CloseCtx = createContext<() => void>(() => {});

/** Composable close button; reads `close` from context so it can live anywhere inside a Dialog. */
export function DialogClose({ className, children, ...props }: ButtonProps) {
  const close = use(CloseCtx);
  const { t } = useI18n();
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("action.close")}
      {...props}
      onPress={close}
      className={cn("-mr-2 -mt-1", className)}
    >
      {children ?? <X aria-hidden="true" />}
    </Button>
  );
}

export function Dialog({
  title,
  description,
  size = "md",
  position = "center",
  children,
  className,
  hideClose,
  ...props
}: DialogProps) {
  const [dirty, setDirty] = useState(false);
  return (
    <ModalOverlay
      isDismissable={!dirty}
      isKeyboardDismissDisabled={dirty}
      {...props}
      className={composeRenderProps(className, (c) =>
        cn(
          "fixed inset-0 z-50 flex justify-center bg-black/40 p-4 backdrop-blur-[2px] entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0",
          position === "top" ? "items-start pt-[12vh]" : "items-center",
          c,
        ),
      )}
    >
      <Modal
        className={cn(
          "max-h-[85vh] w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl entering:animate-in entering:zoom-in-95 entering:slide-in-from-bottom-2 exiting:animate-out exiting:zoom-out-95",
          size === "sm" && "max-w-sm",
          size === "md" && "max-w-lg",
          size === "lg" && "max-w-3xl",
        )}
      >
        <RACDialog className="flex max-h-[85vh] flex-col outline-none">
          {({ close }) => (
            <DirtyCtx value={setDirty}>
              <CloseCtx value={close}>
                <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-4">
                  <div>
                    <Heading slot="title" className="text-[15px] font-semibold tracking-tight">
                      {title}
                    </Heading>
                    {description && <p className="mt-0.5  text-muted-foreground">{description}</p>}
                  </div>
                  {!hideClose && <DialogClose />}
                </div>
                <div className="overflow-auto overscroll-contain px-5 pb-5 pt-3">
                  {typeof children === "function" ? children(close) : children}
                </div>
              </CloseCtx>
            </DirtyCtx>
          )}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
