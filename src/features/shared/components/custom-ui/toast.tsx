import { cn } from "@/lib/utils";
import { Toast, toaster } from "@kobalte/core/toast";
import AlertCircleIcon from "lucide-solid/icons/alert-circle";
import CheckIcon from "lucide-solid/icons/check";
import InfoIcon from "lucide-solid/icons/info";
import XIcon from "lucide-solid/icons/x";
import { createSignal, onMount, type Component } from "solid-js";
import { Dynamic, Match, Portal, Switch } from "solid-js/web";
import { Button } from "../ui/button";
import "./toast.css";

type ToastComponentProps = {
  toastId: number;
  message: string;
  class?: string;
  icon?: Component;
};

export function ToastComponent(props: ToastComponentProps) {
  const [mountState, setMountState] = createSignal("unmounted");
  onMount(() => {
    setMountState("mounted");
  });

  function handleClose() {
    setMountState("unmounting");
    setTimeout(() => {
      toaster.dismiss(props.toastId);
      console.log("DISMISSED!");
    }, 200);
  }

  return (
    <Toast
      toastId={props.toastId}
      data-toast
      data-mount-state={mountState()}
      class={cn(
        "flex flex-col px-3 py-2 bg-card rounded-sm shadow-md border ring-2 ring-card/50",
        props.class,
      )}
    >
      <div class="flex flex-row items-center w-full">
        <Dynamic component={props.icon ?? InfoIcon} class="size-4 mr-2" />
        <Toast.Title class="text-base font-medium flex-1">
          {props.message}
        </Toast.Title>

        <Button variant="ghost" class="!p-1 h-auto" onClick={handleClose}>
          <XIcon class="size-4" />
        </Button>
      </div>
    </Toast>
  );
}

export function InfoToastComponent(props: Omit<ToastComponentProps, "icon">) {
  return <ToastComponent {...props} icon={InfoIcon} />;
}

export function SuccessToastComponent(
  props: Omit<ToastComponentProps, "icon">,
) {
  return <ToastComponent {...props} icon={CheckIcon} />;
}

export function ErrorToastComponent(props: Omit<ToastComponentProps, "icon">) {
  return (
    <ToastComponent
      {...props}
      icon={AlertCircleIcon}
      class="[&>svg]:text-rose-800"
    />
  );
}

export function Toaster() {
  return (
    <Portal>
      <Toast.Region>
        <Toast.List class="p-4 fixed bottom-0 right-0 flex flex-col gap-3 w-96 max-w-screen z-[9999] transition-transform" />
      </Toast.Region>
    </Portal>
  );
}

function show(message: string) {
  return toaster.show((props) => (
    <InfoToastComponent toastId={props.toastId} message={message} />
  ));
}

function success(message: string) {
  return toaster.show((props) => (
    <SuccessToastComponent toastId={props.toastId} message={message} />
  ));
}

function error(message: string) {
  return toaster.show((props) => (
    <ErrorToastComponent toastId={props.toastId} message={message} />
  ));
}

function promise<T, U>(
  promise: Promise<T> | (() => Promise<T>),
  options: {
    loadingMessage?: string;
    successMessage?: string | ((data: T) => string);
    errorMessage?: string | ((error: any) => string);
  } = {
    errorMessage: "An error occurred",
    loadingMessage: "Loading...",
    successMessage: "Success!",
  },
) {
  return toaster.promise(promise, (props) => (
    <Switch>
      <Match when={props.state === "pending"}>
        <InfoToastComponent
          toastId={props.toastId}
          message={options.loadingMessage!}
        />
      </Match>
      <Match when={props.state === "fulfilled"}>
        <SuccessToastComponent
          toastId={props.toastId}
          message={
            typeof options.successMessage === "string"
              ? options.successMessage
              : options.successMessage!(props.data!)
          }
        />
      </Match>
      <Match when={props.state === "rejected"}>
        <ErrorToastComponent
          toastId={props.toastId}
          message={
            typeof options.errorMessage === "string"
              ? options.errorMessage
              : options.errorMessage!(props.error)
          }
        />
      </Match>
    </Switch>
  ));
}

function dismiss(id: number) {
  return toaster.dismiss(id);
}

export const toast = {
  show,
  success,
  error,
  promise,
  dismiss,
};
