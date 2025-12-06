import type { IssueStatus, Team } from "@/db/schema";
import { StatusPickerPopover } from "@/features/issues/components/pickers";
import { create } from "@/features/issues/issue-actions";
import { useAppForm } from "@/features/shared/context/form-context";
import { cn } from "@/lib/utils";
import { Popover } from "@kobalte/core/popover";
import { useNavigate } from "@tanstack/solid-router";
import { useServerFn } from "@tanstack/solid-start";
import { JSONContent } from "@tiptap/core";
import PlusIcon from "lucide-solid/icons/plus";
import XIcon from "lucide-solid/icons/x";
import { createSignal, mergeProps, onMount } from "solid-js";
import * as z from "zod";
import { useKeybinds } from "../../context/keybind.context";
import { TeamAvatar } from "../custom-ui/avatar";
import { PickerPopover } from "../custom-ui/picker-popover";
import { TiptapEditor } from "../tiptap/tiptap-editor";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogSingleLineHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Kbd, KbdGroup } from "../ui/kbd";
import { TextField } from "../ui/text-field";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

type CreateIssueForm = {
  teamKey: string;
  summary: string;
  description: any;
  status: IssueStatus;
};

type CreateDialogProps = {
  workspaceSlug: string;
  teams: Team[];
  buttonClass?: string;
  status?: IssueStatus;
};

function CreateDialog(props: CreateDialogProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const navigate = useNavigate();
  const handleCreate = useServerFn(create);
  const { addKeybind } = useKeybinds();
  const merged = mergeProps(props, {
    status: "backlog" as IssueStatus,
  });

  const form = useAppForm(() => ({
    defaultValues: {
      teamKey: merged.teams.length > 0 ? merged.teams[0].key : "",
      summary: "",
      description: undefined as JSONContent | undefined,
      status: merged.status,
    },
    onSubmit: async ({ value }) => {
      const issue = await handleCreate({
        data: {
          workspaceSlug: merged.workspaceSlug,
          teamKey: value.teamKey,
          issue: value,
        },
      });

      if (!issue) {
        // TODO: show error somehow
        return;
      }

      await navigate({
        to: "/$workspace/issue/$key",
        params: {
          key: issue.key,
          workspace: merged.workspaceSlug,
        },
      });

      setIsOpen(false);
      form.reset();
    },
    validators: {
      onSubmit: z.object({
        teamKey: z.string().min(1, "Team key is required"),
        summary: z.string().min(1, "Summary is required"),
        status: z.enum(["backlog", "to_do", "in_progress", "done"], {
          error:
            "Status is required and must be one of the following: backlog, to_do, in_progress, done",
        }),
        description: z
          .any()
          .refine((val) => val !== null && val !== undefined, {
            message: "Description is required",
          }),
      }),
    },
  }));

  onMount(() => {
    addKeybind("c", () => {
      setIsOpen(true);
    });
  });

  return (
    <Dialog open={isOpen()} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger as="div" class={cn("w-full", merged.buttonClass)}>
          <DialogTrigger as={Button} size="sm" class="w-full">
            <PlusIcon class="size-4" strokeWidth={2.75} />
            Create
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <span class="mr-2">Create a new issue</span>
          <KbdGroup>
            <Kbd>C</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>

      <DialogContent
        class="p-0 gap-0 max-h-screen overflow-auto"
        showCloseButton={false}
      >
        <DialogSingleLineHeader>
          <DialogTitle>New issue</DialogTitle>
          <DialogClose as={Button} class="p-px! h-auto!" variant="ghost">
            <XIcon class="size-4" />
          </DialogClose>
        </DialogSingleLineHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <div class="px-4 py-2 flex flex-col">
            <form.AppField name="summary">
              {(field) => (
                <TextField
                  name={field().name}
                  value={field().state.value}
                  class="pb-3"
                  validationState={
                    field().state.meta.errors.length > 0 ? "invalid" : "valid"
                  }
                >
                  <TextField.Input
                    value={field().state.value}
                    onInput={(e) => field().handleChange(e.currentTarget.value)}
                    onBlur={field().handleBlur}
                    placeholder="Issue title"
                    variant="unstyled"
                    class="text-xl"
                    autofocus
                  />
                  <TextField.ErrorMessage>
                    {field().state.meta.errors.join(", ")}
                  </TextField.ErrorMessage>
                </TextField>
              )}
            </form.AppField>

            <form.AppField name="description">
              {(field) => (
                <TextField
                  name={field().name}
                  validationState={
                    field().state.meta.errors.length > 0 ? "invalid" : "valid"
                  }
                  class="pb-2"
                >
                  <TiptapEditor
                    initialContent={field().state.value}
                    onChange={(content) => field().handleChange(content)}
                    variant="plain"
                    placeholder="Describe the issue..."
                    class="min-h-24"
                  />
                  <TextField.ErrorMessage>
                    {field().state.meta.errors.join(", ")}
                  </TextField.ErrorMessage>
                </TextField>
              )}
            </form.AppField>
          </div>

          <div class="px-4 py-2 flex flex-row gap-2 flex-wrap">
            <form.AppField name="teamKey">
              {(field) => (
                <TeamPicker teams={props.teams} value={field().state.value} />
              )}
            </form.AppField>

            <form.AppField name="status">
              {(field) => (
                <StatusPickerPopover
                  controlled
                  status={field().state.value}
                  onChange={field().handleChange}
                />
              )}
            </form.AppField>
          </div>

          <DialogFooter class="px-4 py-3 border-t">
            <form.Subscribe>
              {(state) => (
                <Button type="submit" size="sm" disabled={!state().canSubmit}>
                  Create issue
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TeamPicker(props: { teams: Team[]; value: string }) {
  const team = props.teams.find((team) => team.key === props.value);
  const options = () =>
    props.teams.map((team) => ({
      id: team.key,
      label: team.name,
      icon: () => <TeamAvatar team={team} size="5" />,
    }));

  return (
    <Popover>
      <Popover.Trigger
        as={Button}
        variant="outline"
        size="sm"
        class="pl-1 pr-2 py-1 h-auto"
      >
        <TeamAvatar team={team} size="5" />
        <span class="truncate">{team?.name ?? "Select team"}</span>
      </Popover.Trigger>
      <PickerPopover options={options()} value={props.value} />
    </Popover>
  );
}

export { CreateDialog };
