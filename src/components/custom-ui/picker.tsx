import type { BaseMapping } from "@/lib/mappings";
import { cn } from "@/lib/utils";
import { Link, type LinkProps, useNavigate } from "@tanstack/solid-router";
import CheckIcon from "lucide-solid/icons/check";
import PlusIcon from "lucide-solid/icons/plus";
import SearchIcon from "lucide-solid/icons/search";
import type { JSX } from "solid-js";
import {
  createEffect,
  createSignal,
  Index,
  Match,
  mergeProps,
  Show,
  Switch,
} from "solid-js";
import { Dynamic } from "solid-js/web";
import { Checkbox } from "../ui/checkbox";
import { TextField } from "../ui/text-field";
import { ScrollArea } from "./scroll-area";

export type PickerOption<TId extends string | number | null = string> = {
  id: TId;
  linkProps?: LinkProps;
} & BaseMapping;

type SinglePickerProps<TId extends string | number | null> = {
  value?: TId | null;
  onChange?: (val: TId) => void;
  multiple?: false;
};

type MultiplePickerProps<TId extends string | number | null> = {
  value?: TId[];
  onChange?: (val: TId) => void;
  multiple: true;
};

export type PickerProps<
  TId extends string | number | null,
  TOption extends PickerOption<TId>,
> = {
  options: readonly TOption[];
  manualFiltering?: boolean;
  loading?: boolean;
  closeOnSelect?: boolean;
  emptyText?: string;
  search?: string;
  isOpen?: boolean;
  // Used for creating new options
  createNew?: boolean;
  createNewLabel?: string;
  inputClass?: string;
  boxClass?: string;

  onCreateNew?: (inputValue: string) => void;
  onSearchChange?: (inputValue: string) => void;
  onClose?: () => void;

  renderOption?: (option: TOption) => JSX.Element;
} & (SinglePickerProps<TId> | MultiplePickerProps<TId>);

export const Picker = <
  TId extends string | number | null,
  TOption extends PickerOption<TId>,
>(
  props: PickerProps<TId, TOption>,
) => {
  const merged = mergeProps(
    {
      emptyText: "No options found.",
      closeOnSelect: true,
      createNew: false,
      createNewLabel: "Create",
      multiple: false,
    },
    props,
  );

  const [searchTerm, setSearchTerm] = createSignal(merged.search ?? "");
  const [highlightedIndex, setHighlightedIndex] = createSignal(0);
  const navigate = useNavigate();

  const filteredOptions = () => {
    if (merged.manualFiltering) {
      return merged.options;
    }

    const options = merged.options.filter((option) => {
      if (searchTerm() === "") {
        return true;
      }

      const query = searchTerm()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");

      return normalize(option.label).includes(query);
    });

    if (merged.createNew && searchTerm() !== "") {
      return [
        ...options,
        {
          id: "create-new" as TId,
          icon: PlusIcon,
          label: `${merged.createNewLabel} "${searchTerm()}"`,
        } as TOption,
      ];
    }

    return options;
  };

  const highlightedOption = () => {
    try {
      return filteredOptions()[highlightedIndex()];
    } catch {
      return undefined;
    }
  };

  const lazyHighlightedOption = () => {
    if (merged.loading) {
      return null;
    }

    return highlightedOption();
  };

  function handleClose() {
    merged.onClose?.();
  }

  function handleChange(option: TOption, close: boolean = false) {
    try {
      if (option.linkProps) {
        navigate(option.linkProps);
        return;
      }

      if (option.id === ("create-new" as TId)) {
        merged.onCreateNew?.(searchTerm());
        handleClose();
        return;
      }

      props.onChange?.(option.id);
    } finally {
      if (close) {
        handleClose();
      }
    }
  }

  function handleClick(e: MouseEvent, option: TOption) {
    if (option.linkProps) {
      if (merged.closeOnSelect) {
        handleClose();
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();

    handleChange(option, merged.closeOnSelect);
  }

  function handleCheckboxChange(option: TOption) {
    handleChange(option, false);
  }

  function changeActiveIndex(newIndex: number) {
    if (newIndex >= 0 && newIndex < filteredOptions().length) {
      setHighlightedIndex(newIndex);
    }
  }

  function scrollToActive() {
    const activeElement = document.querySelector(
      `[data-picker-idx="${highlightedIndex()}"]`,
    ) as any;
    if (activeElement) {
      activeElement.scrollIntoViewIfNeeded
        ? activeElement.scrollIntoViewIfNeeded()
        : activeElement.scrollIntoView();
    }
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        changeActiveIndex(highlightedIndex() - 1);
        scrollToActive();
        break;
      case "ArrowDown":
        e.preventDefault();
        changeActiveIndex(highlightedIndex() + 1);
        scrollToActive();
        break;
      case "Enter":
        e.preventDefault();
        if (highlightedOption()) {
          const option = highlightedOption()!;
          handleChange(option, merged.closeOnSelect);
        }
        break;
      case "Escape":
        e.preventDefault();
        handleClose();
        break;
      case "Home":
        e.preventDefault();
        setHighlightedIndex(0);
        scrollToActive();
        break;
      case "End":
        e.preventDefault();
        setHighlightedIndex(filteredOptions().length - 1);
        scrollToActive();
        break;
    }
  }

  function handleSearchChange(value: string) {
    setSearchTerm(value);
    props.onSearchChange?.(value);
  }

  function isMultipleOptionActive(option: TOption) {
    return Array.isArray(merged.value) && merged.value.includes(option.id);
  }

  createEffect(() => {
    if (merged.isOpen === false) {
      setSearchTerm("");
      setHighlightedIndex(0);
    }
  });

  createEffect(() => {
    if (merged.search) {
      setSearchTerm(merged.search);
    }
  });

  createEffect(() => {
    if (filteredOptions()) {
      setHighlightedIndex(0);
    }
  });

  return (
    <>
      <TextField
        value={searchTerm()}
        onChange={handleSearchChange}
        class="relative"
      >
        <div class="absolute h-full pl-2 top-0 bottom-0 left-0 flex items-center justify-center">
          <SearchIcon class="size-4 text-muted-foreground" />
        </div>
        <TextField.Input
          role="combobox"
          onKeyDown={handleInputKeyDown}
          placeholder="Search..."
          variant="unstyled"
          class={cn(
            "pr-3 pl-7 py-2 text-base border-b shadow-xs",
            merged.inputClass,
          )}
          aria-expanded={merged.isOpen ? "true" : "false"}
          aria-controls="picker-listbox"
          aria-activedescendant={`option-${lazyHighlightedOption()?.id}`}
          aria-autocomplete="list"
          aria-label="Search options"
          onBlur={(e) => {
            e.target.focus();
          }}
        />
      </TextField>

      <Switch>
        <Match when={merged.loading}>
          <div
            class={cn(
              "p-4 text-base text-muted-foreground text-center",
              merged.boxClass,
            )}
          >
            Loading...
          </div>
        </Match>

        <Match when={filteredOptions().length === 0}>
          <div
            class={cn(
              "p-4 text-base text-muted-foreground text-center text-balance",
              merged.boxClass,
            )}
          >
            {merged.emptyText}
          </div>
        </Match>

        <Match when={filteredOptions().length > 0}>
          <div
            class="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {filteredOptions().length} option
            {filteredOptions().length !== 1 ? "s" : ""} available
          </div>

          <ScrollArea>
            <div
              class={cn("flex flex-col p-1", merged.boxClass)}
              id="picker-listbox"
              role="listbox"
              aria-multiselectable={merged.multiple || undefined}
            >
              <Index each={filteredOptions()}>
                {(option, idx) => (
                  <Dynamic
                    component={option().linkProps ? Link : "button"}
                    {...(option().linkProps ?? {})}
                    tabindex="-1"
                    onClick={(e: MouseEvent) => handleClick(e, option())}
                    onPointerDown={(e: MouseEvent) => e.preventDefault()}
                    onMouseOver={() => setHighlightedIndex(idx)}
                    id={`option-${option().id}`}
                    role="option"
                    aria-selected={
                      merged.multiple
                        ? isMultipleOptionActive(option())
                        : merged.value === option().id
                    }
                    data-picker-idx={idx}
                    data-active={highlightedIndex() === idx ? true : undefined}
                    class="group/picker-button"
                  >
                    <div class="flex flex-row items-center text-left truncate gap-2 p-2 group-data-active/picker-button:bg-muted text-base squircle-sm">
                      <Show
                        when={!props.renderOption}
                        fallback={props.renderOption?.(option())}
                      >
                        <Show
                          when={
                            merged.multiple &&
                            option().id !== ("create-new" as TId)
                          }
                        >
                          <Checkbox
                            checked={isMultipleOptionActive(option())}
                            onChange={(e) => handleCheckboxChange(option())}
                            onClick={(e: MouseEvent) => {
                              e.preventDefault();
                              e.stopPropagation();
                            }}
                          />
                        </Show>

                        <Show when={option().icon}>
                          <Dynamic
                            component={option().icon}
                            class={`size-4 shrink-0 ${option().textClass}`}
                          />
                        </Show>

                        <span class="truncate">{option().label}</span>

                        <Show
                          when={merged.value === option().id && !props.multiple}
                        >
                          <CheckIcon class="size-4 ml-auto" />
                        </Show>
                      </Show>
                    </div>
                  </Dynamic>
                )}
              </Index>
            </div>
          </ScrollArea>
        </Match>
      </Switch>
    </>
  );
};
