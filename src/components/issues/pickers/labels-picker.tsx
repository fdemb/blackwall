import { Badge } from "@/components/custom-ui/badge";
import { type PickerOption } from "@/components/custom-ui/picker";
import { PickerPopover } from "@/components/custom-ui/picker-popover";
import { Button } from "@/components/ui/button";
import { useWorkspaceData } from "@/context/workspace-context";
import type { Label } from "@/db/schema";
import {
  addLabelToIssue,
  createLabel,
  getAllLabels,
  removeLabelFromIssue,
} from "@/server/issues/labels.api";
import { Popover } from "@kobalte/core/popover";
import { useMutation, useQueryClient } from "@tanstack/solid-query";
import { useServerFn } from "@tanstack/solid-start";
import PlusIcon from "lucide-solid/icons/plus";
import { createResource, createSignal, Index } from "solid-js";

export function IssueLabelsPicker(props: {
  labels: Label[];
  issueKey: string;
}) {
  const [addOpen, setAddOpen] = createSignal(false);
  const workspaceData = useWorkspaceData();
  const queryClient = useQueryClient();

  const handleGetAllLabels = useServerFn(getAllLabels);
  const handleCreateLabel = useServerFn(createLabel);
  const handleAddLabelToIssue = useServerFn(addLabelToIssue);
  const handleRemoveLabelFromIssue = useServerFn(removeLabelFromIssue);

  const labelIds = () => props.labels.map((label) => label.id);

  const [allLabels] = createResource(
    () => addOpen() === true,
    async () => {
      const allLabels = await handleGetAllLabels({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
        },
      });

      if (!allLabels) {
        return;
      }

      return allLabels.map(
        (label) =>
          ({
            id: label.id,
            label: label.name,
          }) satisfies PickerOption,
      );
    },
  );

  const createNewLabelMutation = useMutation(() => ({
    mutationFn: async (name: string) => {
      const label = await handleCreateLabel({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
          name,
        },
      });

      await handleAddLabelToIssue({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
          issueKey: props.issueKey,
          labelId: label.id,
        },
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [
          "issue",
          "get",
          workspaceData().workspace.slug,
          props.issueKey,
        ],
      });
    },
  }));

  const addExistingLabelMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      await handleAddLabelToIssue({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
          issueKey: props.issueKey,
          labelId: id,
        },
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [
          "issue",
          "get",
          workspaceData().workspace.slug,
          props.issueKey,
        ],
      });
    },
  }));

  const deleteLabelMutation = useMutation(() => ({
    mutationFn: async (id: string) => {
      await handleRemoveLabelFromIssue({
        data: {
          workspaceSlug: workspaceData().workspace.slug,
          issueKey: props.issueKey,
          labelId: id,
        },
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: [
          "issue",
          "get",
          workspaceData().workspace.slug,
          props.issueKey,
        ],
      });
    },
  }));

  function handleChange(id: string) {
    if (labelIds().includes(id)) {
      deleteLabelMutation.mutate(id);
    } else {
      addExistingLabelMutation.mutate(id);
    }
  }

  let savedAnchorRect: DOMRect | null = null;

  function handleAnchorRect(anchor?: HTMLElement) {
    if (savedAnchorRect) {
      return savedAnchorRect;
    }

    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      savedAnchorRect = rect;
      return rect;
    }
  }

  function handleSetOpen(value: boolean) {
    if (!value) {
      savedAnchorRect = null;
    }
    setAddOpen(value);
  }

  return (
    <div class="flex flex-wrap gap-y-2 gap-x-1 items-center">
      <Index each={props.labels}>
        {(label) => <Badge color={label().colorKey}>{label().name}</Badge>}
      </Index>

      <Popover
        placement="left-start"
        gutter={8}
        open={addOpen()}
        onOpenChange={handleSetOpen}
        getAnchorRect={handleAnchorRect}
      >
        <Popover.Trigger
          class="text-muted-foreground hover:text-foreground transition-colors rounded-full size-6"
          as={Button}
          variant="ghost"
          size="sm"
        >
          <PlusIcon class="size-4" />
        </Popover.Trigger>

        <PickerPopover
          multiple
          createNew
          options={allLabels() ?? []}
          value={labelIds()}
          loading={allLabels.loading}
          emptyText="No labels found. Start typing to create."
          createNewLabel="Create label"
          onCreateNew={createNewLabelMutation.mutate}
          onChange={handleChange}
        />
      </Popover>
    </div>
  );
}
