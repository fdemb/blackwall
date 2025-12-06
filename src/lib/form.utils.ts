import { toast } from "@/features/shared/components/custom-ui/toast";
import { FormApi } from "@tanstack/solid-form";

export const validateFields = (
  form: FormApi<any, any, any, any, any, any, any, any, any, any, any, any>,
  fields: string[],
) => {
  const errors: unknown[] = [];
  for (const field of fields) {
    form.validateField(field, "submit");
    form.getAllErrors().fields[field]?.errors?.forEach((error) => {
      errors.push(error);
    });
  }

  return errors;
};

export const tryServerFn = async <T extends unknown>(
  promise: Promise<T>,
  formApi?: FormApi<any, any, any, any, any, any, any, any, any, any, any, any>,
): Promise<T> => {
  try {
    return await promise;
  } catch (error) {
    formApi?.reset();
    if (error instanceof Error && typeof error.message === "string") {
      toast.error(error.message);
    } else {
      toast.error("An unexpected error occurred");
    }
    throw error;
  }
};
