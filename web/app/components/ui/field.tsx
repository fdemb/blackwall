import {
  FieldError as RACFieldError,
  Input as RACInput,
  Label as RACLabel,
  Text,
  TextArea as RACTextArea,
  TextField as RACTextField,
  SearchField as RACSearchField,
  composeRenderProps,
  type FieldErrorProps,
  type InputProps,
  type LabelProps,
  type TextFieldProps,
  type TextAreaProps,
  type SearchFieldProps,
} from "react-aria-components";
import { Search, X } from "lucide-react";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";
import { Button } from "./button";

export const fieldBase =
  "w-full rounded-md border border-input bg-card px-2.5  text-foreground shadow-xs outline-none transition-[transform,opacity] duration-100 placeholder:text-muted-foreground/70 hover:border-muted-foreground/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/25 disabled:opacity-50 invalid:border-destructive";

export function Label({ className, ...props }: LabelProps) {
  return (
    <RACLabel
      {...props}
      className={cn("mb-1 block  font-medium text-muted-foreground", className)}
    />
  );
}
export function Description({ className, ...props }: React.ComponentProps<typeof Text>) {
  return (
    <Text
      {...props}
      slot="description"
      className={cn("mt-1 block  text-muted-foreground", className)}
    />
  );
}
export function FieldError({ className, ...props }: FieldErrorProps) {
  return (
    <RACFieldError
      {...props}
      className={composeRenderProps(className, (c) => cn("mt-1  text-destructive", c))}
    />
  );
}
export function Input({ className, ...props }: InputProps & { ref?: React.Ref<HTMLInputElement> }) {
  return (
    <RACInput
      {...props}
      className={composeRenderProps(className, (c) => cn(fieldBase, "h-8 pointer-coarse:h-10", c))}
    />
  );
}
export function TextArea({ className, ...props }: TextAreaProps) {
  return (
    <RACTextArea
      {...props}
      className={composeRenderProps(className, (c) => cn(fieldBase, "min-h-20 py-2", c))}
    />
  );
}

interface FieldProps extends TextFieldProps {
  label?: string;
  description?: string;
  placeholder?: string;
  error?: string;
  // One component for both cases: single vs. multiline only swaps the inner control, while the
  // label/description/error wiring stays shared. Splitting into TextField/TextAreaField would
  // duplicate that wrapper for no composition gain.
  multiline?: boolean;
  rows?: number;
}
export function TextField({
  label,
  description,
  placeholder,
  error,
  multiline,
  rows,
  className,
  ...props
}: FieldProps) {
  return (
    // A server error must not block resubmission, which native validation does for isInvalid fields.
    <RACTextField
      {...props}
      isInvalid={props.isInvalid || Boolean(error)}
      validationBehavior={error ? "aria" : props.validationBehavior}
      className={composeRenderProps(className, (c) => cn("flex flex-col", c))}
    >
      {label && <Label>{label}</Label>}
      {multiline ? (
        <TextArea placeholder={placeholder} rows={rows} />
      ) : (
        <Input placeholder={placeholder} />
      )}
      {description && <Description>{description}</Description>}
      {error ? (
        <RACFieldError className="mt-1  text-destructive">{error}</RACFieldError>
      ) : (
        <FieldError />
      )}
    </RACTextField>
  );
}

/** A failure from submitting the whole form, as opposed to one invalid field. */
export function FormError({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className=" text-destructive">
      {children}
    </p>
  );
}

export function SearchField({
  placeholder,
  className,
  inputClassName,
  ...props
}: SearchFieldProps & { placeholder?: string; inputClassName?: string }) {
  const { t } = useI18n();
  return (
    <RACSearchField
      {...props}
      className={composeRenderProps(className, (c) => cn("group relative flex items-center", c))}
    >
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
      />
      <RACInput
        placeholder={placeholder}
        className={cn(
          fieldBase,
          "h-8 pl-8 pr-7 pointer-coarse:h-10 [&::-webkit-search-cancel-button]:hidden",
          inputClassName,
        )}
      />
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-0.5 size-6 group-empty:hidden [[data-empty]_&]:hidden"
        aria-label={t("action.clearField")}
      >
        <X aria-hidden="true" className="size-3" />
      </Button>
    </RACSearchField>
  );
}
