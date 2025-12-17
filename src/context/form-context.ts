import { createFormHook, createFormHookContexts } from "@tanstack/solid-form";
import { TanStackTextField } from "../components/ui/text-field";

export const { fieldContext, formContext, useFieldContext } =
  createFormHookContexts();

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TanStackTextField,
  },
  formComponents: {},
});
