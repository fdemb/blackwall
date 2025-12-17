import {
  Popover,
  usePopoverContext,
  type PopoverContentProps,
} from "@kobalte/core/popover";
import { splitProps } from "solid-js";
import { Picker, type PickerOption, type PickerProps } from "./picker";

export const PickerPopover = <
  TId extends string | number | null,
  TOption extends PickerOption<TId>,
>(
  props: PickerProps<TId, TOption> & PopoverContentProps,
) => {
  const [pickerProps, popoverProps] = splitProps(props, [
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
  const popoverCtx = usePopoverContext();

  return (
    <Popover.Portal>
      <Popover.Content
        class="z-50 shadow-md flex flex-col ring-1 rounded-sm ring-foreground/10 bg-card min-w-[12rem] max-w-[16rem]"
        {...popoverProps}
      >
        <Picker
          {...pickerPropsTyped}
          isOpen={popoverCtx.isOpen()}
          onClose={() => {
            popoverCtx.close();
            pickerPropsTyped.onClose?.();
          }}
          boxClass="max-h-[300px]"
        />
      </Popover.Content>
    </Popover.Portal>
  );
};
