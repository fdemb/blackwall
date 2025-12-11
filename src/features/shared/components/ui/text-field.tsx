import { cn } from "@/lib/utils";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { TextField as TextFieldPrimitive } from "@kobalte/core/text-field";
import { cva, type VariantProps } from "class-variance-authority";
import * as Solid from "solid-js";
import { useFieldContext } from "../../context/form-context";
import { labelClasses } from "./label";

const TextField = <T extends Solid.ValidComponent = "div">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive>,
    ["class"],
  );

  return (
    <TextFieldPrimitive
      class={cn("flex flex-col gap-2", local.class)}
      {...rest}
    />
  );
};

const inputVariants = cva("", {
  variants: {
    variant: {
      default:
        "file:text-foreground bg-input rounded-sm placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-9 w-full min-w-0 border px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-primary focus-visible:ring-primary/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
      unstyled: "outline-none placeholder:text-muted-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

const TextFieldInput = <T extends Solid.ValidComponent = "input">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive<T>>
  > &
    VariantProps<typeof inputVariants>,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive.Input> &
      VariantProps<typeof inputVariants>,
    ["class", "variant"],
  );

  return (
    <TextFieldPrimitive.Input
      class={cn(inputVariants({ variant: local.variant }), local.class)}
      {...rest}
    />
  );
};

const TextFieldLabel = <T extends Solid.ValidComponent = "label">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive.Label<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive.Label>,
    ["class"],
  );

  return (
    <TextFieldPrimitive.Label class={cn(labelClasses, local.class)} {...rest} />
  );
};

const TextFieldTextArea = <T extends Solid.ValidComponent = "textarea">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive.TextArea<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive.TextArea>,
    ["class"],
  );

  return (
    <TextFieldPrimitive.TextArea
      class={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        local.class,
      )}
      {...rest}
    />
  );
};

const TextFieldDescription = <T extends Solid.ValidComponent = "p">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive.Description<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive.Description>,
    ["class"],
  );

  return (
    <TextFieldPrimitive.Description
      class={cn("text-muted-foreground text-sm", local.class)}
      {...rest}
    />
  );
};

const TextFieldErrorMessage = <T extends Solid.ValidComponent = "p">(
  props: PolymorphicProps<
    T,
    Solid.ComponentProps<typeof TextFieldPrimitive.ErrorMessage<T>>
  >,
) => {
  const [local, rest] = Solid.splitProps(
    props as Solid.ComponentProps<typeof TextFieldPrimitive.ErrorMessage>,
    ["class"],
  );

  return (
    <TextFieldPrimitive.ErrorMessage
      data-slot="select-error-message"
      class={cn("text-destructive text-sm", local.class)}
      {...rest}
    />
  );
};

TextField.Input = TextFieldInput;
TextField.Label = TextFieldLabel;
TextField.TextArea = TextFieldTextArea;
TextField.Description = TextFieldDescription;
TextField.ErrorMessage = TextFieldErrorMessage;

type FullTextFieldProps = {
  name: string;
  type?: "text" | "email" | "tel" | "password" | "url" | "date" | undefined;
  label?: string | undefined;
  placeholder?: string | undefined;
  value: string | undefined;
  error: string;
  multiline?: boolean | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  ref: (element: HTMLInputElement | HTMLTextAreaElement) => void;
  onInput: Solid.JSX.EventHandler<
    HTMLInputElement | HTMLTextAreaElement,
    InputEvent
  >;
  onChange: Solid.JSX.EventHandler<
    HTMLInputElement | HTMLTextAreaElement,
    Event
  >;
  onBlur: Solid.JSX.EventHandler<
    HTMLInputElement | HTMLTextAreaElement,
    FocusEvent
  >;
};

function FullTextField(props: FullTextFieldProps) {
  const [rootProps, inputProps] = Solid.splitProps(
    props,
    ["name", "value", "required", "disabled"],
    ["placeholder", "ref", "onInput", "onChange", "onBlur"],
  );
  return (
    <TextField
      {...rootProps}
      validationState={props.error ? "invalid" : "valid"}
    >
      <Solid.Show when={props.label}>
        <TextField.Label>{props.label}</TextField.Label>
      </Solid.Show>
      <Solid.Show
        when={props.multiline}
        // @ts-ignore component scheduled for deletion
        fallback={<TextField.Input {...inputProps} type={props.type} />}
      >
        <TextField.TextArea {...inputProps} autoResize />
      </Solid.Show>
      <TextField.ErrorMessage>{props.error}</TextField.ErrorMessage>
    </TextField>
  );
}

type TanStackTextFieldProps = {
  label: string;
  autocomplete?: string;
  placeholder?: string;
  type?: Solid.ComponentProps<"input">["type"];
  rootClass?: string;
  inputClass?: string;
  labelClass?: string;
  autofocus?: boolean;
  beforeInput?: Solid.JSX.Element;
  id?: string;
  describedBy?: string;
  onBlur?: Solid.JSX.EventHandler<
    HTMLInputElement | HTMLTextAreaElement,
    FocusEvent
  >;
};

function TanStackTextField(props: TanStackTextFieldProps) {
  let inputRef!: HTMLInputElement;
  const field = useFieldContext<string>();

  function parseError(error: any) {
    if (typeof error === "string") {
      return error;
    }

    if ("message" in error) {
      return error.message;
    }

    return String(error);
  }

  Solid.onMount(() => {
    if (props.autofocus && inputRef) {
      inputRef.focus();
    }
  });

  return (
    <TextField
      name={field().name}
      value={field().state.value}
      onChange={(e) => field().handleChange(e)}
      validationState={field().state.meta.isValid ? "valid" : "invalid"}
      class={props.rootClass}
    >
      <TextField.Label class={props.labelClass}>{props.label}</TextField.Label>
      <div class="relative">
        {props.beforeInput}
        <TextField.Input
          id={props.id}
          type={props.type}
          aria-describedby={props.describedBy}
          onBlur={(event) => {
            field().handleBlur();
            props.onBlur?.(event);
          }}
          placeholder={props.placeholder}
          class={props.inputClass}
          autofocus={props.autofocus}
          autocomplete={props.autocomplete}
          ref={inputRef}
        />
      </div>
      <Solid.For each={field().state.meta.errors}>
        {(item) => (
          <TextField.ErrorMessage>{parseError(item)}</TextField.ErrorMessage>
        )}
      </Solid.For>
    </TextField>
  );
}

export { FullTextField, TanStackTextField, TextField };
