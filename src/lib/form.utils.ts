import { toast } from "@/components/custom-ui/toast";
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

export const action = async <T extends unknown>(
  promise: Promise<T>,
  formApi?: FormApi<any, any, any, any, any, any, any, any, any, any, any, any>,
): Promise<T> => {
  try {
    const result = await promise;

    if (
      result &&
      typeof result === "object" &&
      "message" in result &&
      typeof result.message === "string"
    ) {
      toast.success(result.message);
    }

    return result;
  } catch (error) {
    if (error instanceof Error && typeof error.message === "string") {
      toast.error(error.message);
    } else {
      toast.error("An unexpected error occurred");
    }
    throw error;
  } finally {
    formApi?.reset();
  }
};
