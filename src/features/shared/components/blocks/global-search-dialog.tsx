import { globalSearch } from "@/features/global-search/actions";
import { debounce } from "@solid-primitives/scheduled";
import { keepPreviousData, useQuery } from "@tanstack/solid-query";
import { useServerFn } from "@tanstack/solid-start";
import SearchIcon from "lucide-solid/icons/search";
import { createSignal, Match, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { UserAvatar } from "../custom-ui/avatar";
import type { PickerOption } from "../custom-ui/picker";
import { PickerDialog } from "../custom-ui/picker-dialog";
import { Button } from "../ui/button";
import { Dialog, DialogTrigger } from "../ui/dialog";

interface PickerOptionWithType extends PickerOption {
  type: "issue" | "user";
}

export function GlobalSearchDialog(props: { workspaceSlug: string }) {
  const [open, setOpen] = createSignal(false);
  const [searchTerm, setSearchTerm] = createSignal("");
  const setSearchTermDebounced = debounce(setSearchTerm, 300);
  const globalSearchFn = useServerFn(globalSearch);

  const globalSearchQuery = useQuery(() => ({
    get queryKey() {
      return ["global-search", searchTerm(), open()];
    },
    queryFn: () => {
      return globalSearchFn({
        data: {
          searchTerm: searchTerm(),
          workspaceSlug: props.workspaceSlug,
        },
      });
    },
    placeholderData: keepPreviousData,
  }));

  const handleOpenChange = (open: boolean) => {
    setOpen(open);
    if (!open) {
      setTimeout(() => {
        setSearchTerm("");
      }, 200);
    }
  };

  const options = () => {
    const issueOptions =
      globalSearchQuery.data?.issues.map(
        (item) =>
          ({
            id: item.key,
            label: item.summary,
            linkProps: {
              to: "/$workspace/issue/$key",
              params: {
                workspace: props.workspaceSlug,
                key: item.key,
              },
            },
            type: "issue",
          }) as PickerOptionWithType,
      ) || [];

    const userOptions =
      globalSearchQuery.data?.users.map(
        (item) =>
          ({
            id: item.id,
            label: item.name,
            icon: () => <UserAvatar user={item} size="xs" />,
            linkProps: {}, // TODO
            type: "user",
          }) as PickerOptionWithType,
      ) || [];

    return issueOptions.concat(userOptions);
  };

  return (
    <Dialog open={open()} onOpenChange={handleOpenChange}>
      <DialogTrigger as={Button} size="iconSm" variant="outline">
        <SearchIcon class="size-4" strokeWidth={2.75} />
      </DialogTrigger>

      <PickerDialog
        options={options()}
        loading={globalSearchQuery.isLoading}
        manualFiltering
        search={searchTerm()}
        onSearchChange={setSearchTermDebounced}
        closeOnSelect
        renderOption={(option) => (
          <div class="flex flex-row items-center gap-2">
            <Switch>
              <Match when={option.type === "issue"}>
                <span class="px-1 py-0.5 text-xs bg-muted text-muted-foreground rounded-sm border">
                  {option.id}
                </span>
                <span class="font-medium text-foreground">{option.label}</span>
              </Match>

              <Match when={option.type === "user"}>
                <Dynamic component={option.icon!} class="size-4" />
                <span>{option.label}</span>
              </Match>
            </Switch>
          </div>
        )}
      />
    </Dialog>
  );
}
