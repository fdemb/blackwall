import {
  type DialogContentProps,
  useDialogContext,
} from "@kobalte/core/dialog";
import { splitProps } from "solid-js";
import { DialogContent } from "../ui/dialog";
import { Picker, PickerOption, PickerProps } from "./picker";

export const PickerDialog = <
  TId extends string | number,
  TOption extends PickerOption<TId>,
>(
  props: PickerProps<TId, TOption> & DialogContentProps,
) => {
  const [pickerProps, dialogProps] = splitProps(props, [
    "id",
    "options",
    "value",
    "onChange",
    "multiple",
    "manualFiltering",
    "loading",
    "closeOnSelect",
    "emptyText",
    "search",
    "isOpen",
    "createNew",
    "createNewLabel",
    "onCreateNew",
    "onSearchChange",
    "onClose",
    "renderOption",
  ]);

  const pickerPropsTyped = pickerProps as PickerProps<TId, TOption>;
  const popoverCtx = useDialogContext();

  return (
    <DialogContent {...dialogProps} class="p-0 gap-0" showCloseButton={false}>
      <Picker
        {...pickerPropsTyped}
        isOpen={popoverCtx.isOpen()}
        onClose={() => {
          popoverCtx.close();
          pickerPropsTyped.onClose?.();
        }}
        boxClass="h-[300px]"
      />
    </DialogContent>
  );
};
