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
import { Button } from "./button";

export { DialogTrigger, Heading };

interface DialogProps extends Omit<ModalOverlayProps, "children"> {
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  position?: "center" | "top";
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
  hideClose?: boolean;
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
  return (
    <ModalOverlay
      isDismissable
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
            <>
              <div className="flex items-start justify-between gap-4 px-5 pb-1 pt-4">
                <div>
                  <Heading slot="title" className="text-[15px] font-semibold tracking-tight">
                    {title}
                  </Heading>
                  {description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
                  )}
                </div>
                {!hideClose && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onPress={close}
                    aria-label="Close"
                    className="-mr-2 -mt-1"
                  >
                    <X />
                  </Button>
                )}
              </div>
              <div className="overflow-auto px-5 pb-5 pt-3">
                {typeof children === "function" ? children(close) : children}
              </div>
            </>
          )}
        </RACDialog>
      </Modal>
    </ModalOverlay>
  );
}
